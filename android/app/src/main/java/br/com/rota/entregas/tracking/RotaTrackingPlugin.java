package br.com.rota.entregas.tracking;

import android.Manifest;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.core.content.ContextCompat;
import androidx.lifecycle.Lifecycle;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.util.UUID;
import java.util.Map;
import java.util.WeakHashMap;

@CapacitorPlugin(name = "RotaTracking", permissions = {
    @Permission(alias = "location", strings = { Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION }),
    @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS })
})
public final class RotaTrackingPlugin extends Plugin {
    private final Map<PluginCall, Long> attempts = new WeakHashMap<>();
    @Override public void load() { TrackingRuntime.init(getContext()); }

    @PluginMethod public void getDeviceId(PluginCall call) {
        SharedPreferences preferences = getContext().getSharedPreferences("rota-tracking-device", 0);
        String id = preferences.getString("id", null);
        if (id == null) {
            synchronized (RotaTrackingPlugin.class) {
                id = preferences.getString("id", null);
                if (id == null) { id = UUID.randomUUID().toString(); preferences.edit().putString("id", id).apply(); }
            }
        }
        JSObject result = new JSObject(); result.put("deviceId", id); call.resolve(result);
    }

    @PluginMethod public void getStatus(PluginCall call) {
        if (!fineGranted() && TrackingRuntime.service != null && TrackingRuntime.service.isCapturing())
            TrackingRuntime.authorizationLost("A permissão de localização precisa foi removida. O registro GPS foi parado.");
        call.resolve(TrackingRuntime.status());
    }

    @PluginMethod public void start(PluginCall call) {
        try {
            TrackingRuntime.Credentials value = readCredentials(call, true);
            if (TrackingDatabase.get(getContext()).stopTime(value.owner, value.sessionId) != null) {
                call.reject("Envie os pontos GPS pendentes antes de iniciar outro registro.", "GPS_PENDING"); return;
            }
        } catch (Exception invalid) { call.reject(invalid.getMessage()); return; }
        getActivity().runOnUiThread(() -> {
            if (!visible()) { call.reject("Abra o aplicativo para iniciar o registro GPS."); return; }
            long ticket = TrackingRuntime.reserveStart();
            if (ticket < 0) { call.reject("Já existe um início ou registro GPS em andamento."); return; }
            attempts.put(call, ticket);
            if (!fineGranted()) requestPermissionForAlias("location", call, "locationResult");
            else requestNotificationOrStart(call);
        });
    }

    @PermissionCallback private void locationResult(PluginCall call) {
        if (!validAttempt(call)) { finishCancelled(call); return; }
        if (!fineGranted()) {
            TrackingRuntime.setError("Permita localização precisa enquanto usa o aplicativo para registrar os quilômetros.");
            releaseAttempt(call); call.resolve(TrackingRuntime.status()); return;
        }
        requestNotificationOrStart(call);
    }

    private void requestNotificationOrStart(PluginCall call) {
        if (!validAttempt(call)) { finishCancelled(call); return; }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && ContextCompat.checkSelfPermission(getContext(), Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
            requestPermissionForAlias("notifications", call, "notificationResult");
        else begin(call);
    }

    @PermissionCallback private void notificationResult(PluginCall call) {
        // Denying notifications does not deny location; Android still shows the foreground service in its task manager.
        begin(call);
    }

    private void begin(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (!validAttempt(call)) { finishCancelled(call); return; }
            if (!visible()) { releaseAttempt(call); call.reject("Abra o aplicativo para iniciar o registro GPS."); return; }
            if (!fineGranted()) { releaseAttempt(call); call.resolve(TrackingRuntime.status()); return; }
            boolean prepared = false;
            try {
                TrackingRuntime.Credentials value = readCredentials(call, true);
                if (TrackingDatabase.get(getContext()).stopTime(value.owner, value.sessionId) != null) {
                    releaseAttempt(call); call.reject("Envie os pontos GPS pendentes antes de iniciar outro registro.", "GPS_PENDING"); return;
                }
                Long ticket = attempts.remove(call);
                if (ticket == null || !TrackingRuntime.prepareStart(value, ticket, call::resolve)) return;
                prepared = true;
                Intent intent = new Intent(getContext(), TrackingService.class).setAction(TrackingService.ACTION_START);
                // Only the action is sent through Android; tokens are never written into Intent extras.
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) getContext().startForegroundService(intent);
                else getContext().startService(intent);
            } catch (Exception unavailable) {
                releaseAttempt(call);
                if (prepared) TrackingRuntime.startFailed("Não foi possível iniciar o registro GPS. Abra o aplicativo e tente novamente.");
                else call.reject(unavailable.getMessage() == null ? "Não foi possível iniciar o registro GPS." : unavailable.getMessage());
            }
        });
    }

    @PluginMethod public void stop(PluginCall call) { TrackingRuntime.stop(call::resolve); }

    @PluginMethod public void sync(PluginCall call) {
        try {
            TrackingRuntime.Credentials value = readCredentials(call, false);
            TrackingRuntime.MAIN.post(() -> TrackingRuntime.sync(value, call::resolve));
        } catch (Exception invalid) { call.reject(invalid.getMessage()); }
    }

    @PluginMethod public void openSettings(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getContext().getPackageName()));
            getActivity().startActivity(intent); call.resolve();
        });
    }

    private boolean fineGranted() { return ContextCompat.checkSelfPermission(getContext(), Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED; }
    private boolean visible() { return getActivity() != null && getActivity().getLifecycle().getCurrentState().isAtLeast(Lifecycle.State.RESUMED); }

    private TrackingRuntime.Credentials readCredentials(PluginCall call, boolean start) throws Exception {
        String driver = call.getString("driverId"), session = call.getString("sessionId"), device = call.getString("deviceId");
        if (!identifier(driver) || (start && (!identifier(session) || !identifier(device)))) throw new IllegalArgumentException("Dados da sessão GPS ausentes.");
        return new TrackingRuntime.Credentials(call.getString("apiUrl"), call.getString("token"), call.getString("userId"), call.getString("expiresAt"), driver, session, device);
    }

    private boolean identifier(String value) { return value != null && !value.trim().isEmpty() && value.length() <= 256 && !value.contains("\n"); }
    private boolean validAttempt(PluginCall call) { Long ticket = attempts.get(call); return ticket != null && TrackingRuntime.validStart(ticket); }
    private void releaseAttempt(PluginCall call) { Long ticket = attempts.remove(call); if (ticket != null) TrackingRuntime.releaseStart(ticket); }
    private void finishCancelled(PluginCall call) { releaseAttempt(call); call.reject("O início do registro GPS foi cancelado. Entre novamente para iniciar."); }
}
