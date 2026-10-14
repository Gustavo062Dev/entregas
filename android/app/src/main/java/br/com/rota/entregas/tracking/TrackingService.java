package br.com.rota.entregas.tracking;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.Bundle;
import android.os.IBinder;
import android.os.Looper;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;
import br.com.rota.entregas.MainActivity;
import br.com.rota.entregas.R;
import java.util.UUID;
import org.json.JSONObject;

/** Explicitly started location foreground service; never restarts after process death. */
public final class TrackingService extends Service implements LocationListener {
    public static final String ACTION_START = "br.com.rota.entregas.tracking.START";
    public static final String ACTION_STOP = "br.com.rota.entregas.tracking.STOP";
    private static final String CHANNEL = "rota-location";
    private static final int NOTIFICATION_ID = 1707;
    private LocationManager locations;
    private String trackingOwner;
    private String trackingSession;
    private volatile boolean capturing;
    private long lastRecordedAt;

    private final Runnable uploadTick = new Runnable() {
        @Override public void run() {
            if (!capturing) return;
            if (!TrackingRuntime.captureAllowed(trackingOwner, trackingSession)) {
                TrackingRuntime.authorizationLost("Sua sessão expirou. Entre novamente para continuar o registro GPS."); return;
            }
            TrackingRuntime.upload(); TrackingRuntime.MAIN.postDelayed(this, 10000);
        }
    };

    private final Runnable expiration = () -> {
        if (capturing && trackingOwner != null && !TrackingRuntime.captureAllowed(trackingOwner, trackingSession))
            TrackingRuntime.authorizationLost("Sua sessão expirou. Entre novamente para continuar o registro GPS.");
    };

    @Override public void onCreate() {
        super.onCreate(); TrackingRuntime.init(this); TrackingRuntime.service = this;
        locations = (LocationManager) getSystemService(LOCATION_SERVICE);
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null || ACTION_STOP.equals(intent.getAction())) { TrackingRuntime.stop(null); return START_NOT_STICKY; }
        TrackingRuntime.Credentials value = TrackingRuntime.takeStart();
        if (value == null) { if (!capturing) stopSelf(); return START_NOT_STICKY; }
        trackingOwner = value.owner; trackingSession = value.sessionId;
        lastRecordedAt = 0;
        try {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED)
                throw new SecurityException("fine location required");
            boolean gps = locations != null && locations.isProviderEnabled(LocationManager.GPS_PROVIDER);
            boolean network = locations != null && locations.isProviderEnabled(LocationManager.NETWORK_PROVIDER);
            if (!gps && !network) {
                TrackingRuntime.startFailed("Ative a localização do Android para registrar os quilômetros."); stopSelf(); return START_NOT_STICKY;
            }
            createChannel(); Notification notification = notification();
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
            else startForeground(NOTIFICATION_ID, notification);
            if (!TrackingRuntime.captureAllowed(value.owner, value.sessionId)) {
                TrackingRuntime.startFailed("Sua sessão expirou. Entre novamente."); stopSelf(); return START_NOT_STICKY;
            }
            TrackingDatabase db = TrackingDatabase.get(this);
            db.closeOrphans(value.owner, value.sessionId, TrackingRuntime.iso(System.currentTimeMillis()));
            db.createSession(value.owner, value.sessionId, value.driverId, TrackingRuntime.iso(System.currentTimeMillis()));
            capturing = true;
            // The foreground service owns these listeners, independent of WebView visibility.
            if (gps) locations.requestLocationUpdates(LocationManager.GPS_PROVIDER, 5000, 0, this, Looper.getMainLooper());
            if (network) locations.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, 5000, 0, this, Looper.getMainLooper());
            TrackingRuntime.MAIN.post(uploadTick);
            TrackingRuntime.MAIN.postDelayed(expiration, Math.max(1, value.expiresAt - System.currentTimeMillis()));
            TrackingRuntime.started();
        } catch (SecurityException denied) {
            stopCapture(); TrackingRuntime.startFailed("Permita localização precisa enquanto usa o aplicativo para registrar os quilômetros."); stopSelf();
        } catch (Exception unavailable) {
            stopCapture(); TrackingRuntime.startFailed("Não foi possível iniciar o registro GPS. Abra o aplicativo e tente novamente."); stopSelf();
        }
        return START_NOT_STICKY;
    }

    boolean isCapturing() { return capturing; }

    void stopCapture() {
        capturing = false; // Gate callbacks immediately, including those already waiting on the main thread.
        TrackingRuntime.MAIN.removeCallbacks(uploadTick); TrackingRuntime.MAIN.removeCallbacks(expiration);
        if (locations != null) try { locations.removeUpdates(this); } catch (SecurityException ignored) { }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) stopForeground(STOP_FOREGROUND_REMOVE);
        else stopForeground(true);
    }

    @Override public void onLocationChanged(Location location) {
        if (!capturing || trackingOwner == null || !TrackingRuntime.captureAllowed(trackingOwner, trackingSession)) return;
        // Preserve the provider timestamp; never relabel a cached location as a new sample.
        long recordedAt = location.getTime();
        if (recordedAt <= 0 || recordedAt <= lastRecordedAt || !location.hasAccuracy()) return;
        double latitude = location.getLatitude(), longitude = location.getLongitude(), accuracy = location.getAccuracy();
        if (Double.isNaN(latitude) || Double.isNaN(longitude) || Double.isNaN(accuracy) || Double.isInfinite(accuracy) || accuracy <= 0 || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return;
        try {
            JSONObject point = new JSONObject(); point.put("id", UUID.randomUUID().toString()); point.put("latitude", latitude); point.put("longitude", longitude);
            point.put("accuracy", accuracy); point.put("recordedAt", TrackingRuntime.iso(recordedAt));
            TrackingDatabase.get(this).enqueue(trackingOwner, trackingSession, point);
            // A provider's bad future clock is rejected by the server and cannot suppress later real fixes.
            if (recordedAt <= System.currentTimeMillis() + 30000) lastRecordedAt = recordedAt;
        } catch (Exception unavailable) {
            stopCapture();
            TrackingRuntime.authorizationLost("Não foi possível salvar o ponto GPS neste aparelho. O registro foi parado para evitar perda silenciosa de quilômetros.");
        }
    }

    @Override public void onProviderDisabled(String provider) {
        if (!capturing) return;
        boolean available = false;
        try { available = locations.isProviderEnabled(LocationManager.GPS_PROVIDER) || locations.isProviderEnabled(LocationManager.NETWORK_PROVIDER); } catch (Exception ignored) { }
        if (!available) TrackingRuntime.setError("A localização do Android está desativada. Ative-a para continuar registrando os quilômetros.");
    }
    @Override public void onProviderEnabled(String provider) { }
    @Override public void onStatusChanged(String provider, int status, Bundle extras) { }

    private void createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(CHANNEL, "Registro GPS de entregas", NotificationManager.IMPORTANCE_LOW);
            channel.setDescription("Mostra quando o Rota está registrando a localização e permite parar o registro.");
            ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).createNotificationChannel(channel);
        }
    }

    private Notification notification() {
        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent content = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Intent stop = new Intent(this, TrackingService.class).setAction(ACTION_STOP);
        PendingIntent stopAction = PendingIntent.getService(this, 1, stop, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new NotificationCompat.Builder(this, CHANNEL).setSmallIcon(R.drawable.ic_tracking)
            .setContentTitle("Rota · Registro GPS ativo").setContentText("Sua localização está sendo registrada para medir os quilômetros.")
            .setContentIntent(content).setOngoing(true).setOnlyAlertOnce(true).setCategory(NotificationCompat.CATEGORY_SERVICE)
            .addAction(R.drawable.ic_tracking, "Parar registro", stopAction).build();
    }

    @Override public void onDestroy() { stopCapture(); TrackingRuntime.serviceDestroyed(this); trackingOwner = null; trackingSession = null; super.onDestroy(); }
    @Override public IBinder onBind(Intent intent) { return null; }
}
