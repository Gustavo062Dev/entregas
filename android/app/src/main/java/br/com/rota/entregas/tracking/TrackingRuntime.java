package br.com.rota.entregas.tracking;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Handler;
import android.os.Looper;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.text.ParsePosition;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.TimeZone;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import javax.net.ssl.HttpsURLConnection;
import org.json.JSONArray;
import org.json.JSONObject;

/** Process-only credentials and one serialized uploader; SQLite contains no credentials. */
final class TrackingRuntime {
    interface Callback { void complete(JSObject status); }
    static final Handler MAIN = new Handler(Looper.getMainLooper());
    private static final Object LOCK = new Object();
    private static final ScheduledExecutorService NETWORK = Executors.newSingleThreadScheduledExecutor();
    private static Context context;
    private static Credentials credentials;
    private static Credentials pendingStart;
    private static Callback startCallback;
    private static long startTicket = -1;
    private static Credentials deferredSync;
    private static final List<Callback> syncCallbacks = new ArrayList<>();
    private static final List<Callback> stopCallbacks = new ArrayList<>();
    private static boolean stopping;
    private static boolean uploadQueued;
    private static long generation;
    private static String owner;
    private static String sessionId;
    private static String error = "";
    private static HttpsURLConnection connection;
    static volatile TrackingService service;

    static void init(Context app) { synchronized (LOCK) { context = app.getApplicationContext(); } }

    static final class Credentials {
        final String apiUrl, token, userId, driverId, sessionId, deviceId, owner;
        final long expiresAt;

        Credentials(String apiUrl, String token, String userId, String expiresAt, String driverId, String sessionId, String deviceId) throws Exception {
            URI uri = new URI(apiUrl == null ? "" : apiUrl.trim());
            if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null || uri.getUserInfo() != null || uri.getQuery() != null || uri.getFragment() != null || uri.getPort() == 0 || uri.getPort() > 65535)
                throw new IllegalArgumentException("Configure uma API HTTPS sem credenciais ou parâmetros na URL.");
            String path = uri.getPath() == null ? "" : uri.getPath();
            while (path.endsWith("/")) path = path.substring(0, path.length() - 1);
            this.apiUrl = new URI("https", null, uri.getHost().toLowerCase(Locale.ROOT), uri.getPort(), path, null, null).toASCIIString();
            this.token = required(token, "Sessão de acesso ausente.");
            if (this.token.length() > 8192 || this.token.matches(".*[\\x00-\\x20\\x7f].*")) throw new IllegalArgumentException("Sessão de acesso inválida.");
            this.userId = required(userId, "Usuário ausente.");
            this.driverId = required(driverId, "Entregador ausente."); this.sessionId = sessionId; this.deviceId = deviceId;
            this.expiresAt = parseIso(expiresAt);
            if (this.expiresAt <= System.currentTimeMillis()) throw new IllegalArgumentException("Sua sessão expirou. Entre novamente.");
            this.owner = sha256(this.apiUrl + "\n" + this.userId + "\n" + this.driverId);
        }

        private static String required(String text, String message) {
            if (text == null || text.trim().isEmpty() || text.length() > 8192) throw new IllegalArgumentException(message);
            return text;
        }
    }

    static String iso(long time) {
        SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
        format.setTimeZone(TimeZone.getTimeZone("UTC")); return format.format(new Date(time));
    }

    private static long parseIso(String text) {
        if (text == null) throw new IllegalArgumentException("Validade da sessão ausente.");
        for (String pattern : new String[] { "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", "yyyy-MM-dd'T'HH:mm:ss'Z'" }) {
            SimpleDateFormat format = new SimpleDateFormat(pattern, Locale.US); format.setLenient(false); format.setTimeZone(TimeZone.getTimeZone("UTC"));
            ParsePosition position = new ParsePosition(0); Date value = format.parse(text, position);
            if (value != null && position.getIndex() == text.length()) return value.getTime();
        }
        throw new IllegalArgumentException("Validade da sessão inválida.");
    }

    private static String sha256(String value) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
        StringBuilder result = new StringBuilder(); for (byte item : digest) result.append(String.format(Locale.US, "%02x", item & 255)); return result.toString();
    }

    static long reserveStart() {
        synchronized (LOCK) {
            if (stopping || startTicket != -1 || pendingStart != null || (service != null && service.isCapturing())) return -1;
            disconnectLocked(); generation++; uploadQueued = false; startTicket = generation; return startTicket;
        }
    }

    static boolean validStart(long ticket) { synchronized (LOCK) { return ticket >= 0 && ticket == generation && ticket == startTicket && !stopping; } }
    static void releaseStart(long ticket) {
        synchronized (LOCK) {
            if (startTicket == ticket) {
                startTicket = -1;
                if (service == null || !service.isCapturing()) credentials = null;
            }
        }
    }

    static boolean prepareStart(Credentials value, long ticket, Callback callback) {
        synchronized (LOCK) {
            if (!validStart(ticket)) { callback.complete(status()); return false; }
            if (stopping || pendingStart != null || (service != null && service.isCapturing())) {
                error = "Já existe um registro GPS ativo. Pare o registro atual antes de iniciar outro.";
                callback.complete(status()); return false;
            }
            startTicket = -1;
            disconnectLocked(); uploadQueued = false;
            credentials = value; pendingStart = value; startCallback = callback;
            owner = value.owner; sessionId = value.sessionId; error = "";
            return true;
        }
    }

    static Credentials takeStart() { synchronized (LOCK) { Credentials result = pendingStart; pendingStart = null; return result; } }

    static void started() {
        Callback callback;
        synchronized (LOCK) { callback = startCallback; startCallback = null; }
        if (callback != null) callback.complete(status());
    }

    static void startFailed(String message) {
        synchronized (LOCK) { error = message; credentials = null; pendingStart = null; startTicket = -1; disconnectLocked(); generation++; uploadQueued = false; }
        started();
    }

    static boolean captureAllowed(String expectedOwner, String expectedSession) {
        synchronized (LOCK) {
            return !stopping && credentials != null && credentials.owner.equals(expectedOwner) && expectedSession != null && expectedSession.equals(sessionId)
                && credentials.expiresAt > System.currentTimeMillis() && ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
        }
    }

    static void setError(String message) { synchronized (LOCK) { error = message; } }

    static JSObject status() {
        synchronized (LOCK) {
            JSObject result = new JSObject();
            boolean running = service != null && service.isCapturing() && credentials != null && credentials.expiresAt > System.currentTimeMillis() && !stopping;
            result.put("running", running); result.put("pending", TrackingDatabase.get(context).pending(owner));
            result.put("dropped", TrackingDatabase.get(context).dropped(owner)); result.put("error", error);
            if (sessionId != null) result.put("sessionId", sessionId);
            JSObject last = TrackingDatabase.get(context).lastPoint(owner, sessionId); if (last != null) result.put("lastPoint", last);
            result.put("permission", ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED ? "granted" : "denied");
            return result;
        }
    }

    private static JSObject neutralStatus() {
        JSObject result = new JSObject(); result.put("running", false); result.put("pending", 0); result.put("dropped", 0); result.put("error", ""); return result;
    }

    private static void deferSync(Credentials value, Callback callback) {
        if (deferredSync != null && !deferredSync.owner.equals(value.owner)) {
            for (Callback previous : syncCallbacks) previous.complete(neutralStatus());
            syncCallbacks.clear();
        }
        deferredSync = value; syncCallbacks.add(callback);
    }

    static void sync(Credentials value, Callback callback) {
        boolean differentOwner;
        synchronized (LOCK) {
            if (stopping) {
                if (credentials != null && credentials.owner.equals(value.owner) && credentials.token.equals(value.token)) { callback.complete(status()); return; }
                deferSync(value, callback); return;
            }
            differentOwner = owner != null && !owner.equals(value.owner);
        }
        if (differentOwner && service != null && service.isCapturing()) {
            // A new login must not inherit a still-running service from another account.
            synchronized (LOCK) { deferSync(value, callback); }
            stop(null); return;
        }
        synchronized (LOCK) {
            disconnectLocked(); generation++; startTicket = -1; uploadQueued = false;
            credentials = value; owner = value.owner; error = "";
            if (differentOwner || service == null || !service.isCapturing()) {
                // Detach a stopped service before it can clear credentials supplied by this new login.
                TrackingService old = service; service = null; if (old != null) old.stopSelf(); sessionId = null;
            }
            TrackingDatabase.get(context).closeOrphans(owner, service != null && service.isCapturing() ? sessionId : null, iso(System.currentTimeMillis()));
        }
        upload(); callback.complete(status());
    }

    static void upload() {
        final Credentials value; final long taskGeneration;
        synchronized (LOCK) {
            if (uploadQueued || stopping || credentials == null) return;
            if (credentials.expiresAt <= System.currentTimeMillis()) { authorizationLost("Sua sessão expirou. Entre novamente."); return; }
            uploadQueued = true; value = credentials; taskGeneration = generation;
        }
        NETWORK.execute(() -> {
            try { flush(value, taskGeneration, System.currentTimeMillis() + 60000); }
            finally {
                synchronized (LOCK) {
                    if (taskGeneration == generation) {
                        uploadQueued = false;
                        // A foreground sync without an active service keeps its token only during the request.
                        if (service == null || !service.isCapturing()) credentials = null;
                    }
                }
            }
        });
    }

    static void stop(Callback callback) {
        if (Looper.myLooper() != Looper.getMainLooper()) { MAIN.post(() -> stop(callback)); return; }
        final Credentials value; final long taskGeneration;
        synchronized (LOCK) {
            if (callback != null) stopCallbacks.add(callback);
            if (stopping) {
                // A second explicit stop/logout cancels a newer login's queued sync as well.
                deferredSync = null;
                for (Callback queued : syncCallbacks) queued.complete(neutralStatus());
                syncCallbacks.clear(); return;
            }
            stopping = true;
            if (service != null) service.stopCapture();
            if (owner != null && sessionId != null) TrackingDatabase.get(context).pendingStop(owner, sessionId, iso(System.currentTimeMillis()));
            disconnectLocked(); generation++; startTicket = -1; uploadQueued = false; pendingStart = null;
            value = credentials; taskGeneration = generation;
        }
        // Bound logout to less than eight seconds even when a device's network is unresponsive.
        MAIN.postDelayed(() -> finishStop(taskGeneration), 7500);
        if (value == null || value.expiresAt <= System.currentTimeMillis()) { finishStop(taskGeneration); return; }
        NETWORK.execute(() -> {
            try { flush(value, taskGeneration, System.currentTimeMillis() + 7000); }
            finally { MAIN.post(() -> finishStop(taskGeneration)); }
        });
    }

    private static void finishStop(long expectedGeneration) {
        List<Callback> callbacks, queuedSyncCallbacks; Credentials nextSync; TrackingService oldService;
        synchronized (LOCK) {
            if (!stopping || generation != expectedGeneration) return;
            disconnectLocked(); credentials = null; pendingStart = null; generation++; uploadQueued = false; stopping = false;
            callbacks = new ArrayList<>(stopCallbacks); stopCallbacks.clear();
            oldService = service; service = null;
            nextSync = deferredSync; deferredSync = null;
            queuedSyncCallbacks = new ArrayList<>(syncCallbacks); syncCallbacks.clear();
        }
        if (oldService != null) oldService.stopSelf();
        started();
        JSObject state = status(); for (Callback callback : callbacks) callback.complete(state);
        if (nextSync != null) sync(nextSync, nextState -> { for (Callback callback : queuedSyncCallbacks) callback.complete(nextState); });
    }

    static void authorizationLost(String message) {
        long expectedGeneration; String expectedOwner;
        synchronized (LOCK) { expectedGeneration = generation; expectedOwner = owner; }
        authorizationLost(message, expectedGeneration, expectedOwner);
    }

    private static void authorizationLost(String message, long expectedGeneration, String expectedOwner) {
        long stopGeneration;
        synchronized (LOCK) {
            if (generation != expectedGeneration || (expectedOwner != null && !expectedOwner.equals(owner))) return;
            error = message; credentials = null; pendingStart = null; startTicket = -1; disconnectLocked(); generation++; uploadQueued = false;
            stopGeneration = generation;
            if (owner != null && sessionId != null) TrackingDatabase.get(context).pendingStop(owner, sessionId, iso(System.currentTimeMillis()));
        }
        MAIN.post(() -> {
            synchronized (LOCK) { if (generation != stopGeneration || (expectedOwner != null && !expectedOwner.equals(owner))) return; }
            TrackingService current = service;
            if (current != null) { current.stopCapture(); current.stopSelf(); }
            started();
            synchronized (LOCK) {
                if (!stopping || generation != stopGeneration) return;
            }
            finishStop(stopGeneration);
        });
    }

    static void serviceDestroyed(TrackingService old) {
        synchronized (LOCK) {
            if (service != old) return;
            service = null;
            if (!stopping) {
                if (owner != null && sessionId != null) TrackingDatabase.get(context).pendingStop(owner, sessionId, iso(System.currentTimeMillis()));
                credentials = null; disconnectLocked(); generation++; startTicket = -1; uploadQueued = false;
            }
        }
    }

    private static boolean valid(Credentials value, long expectedGeneration, long deadline) {
        synchronized (LOCK) { return credentials != null && generation == expectedGeneration && credentials.owner.equals(value.owner) && value.expiresAt > System.currentTimeMillis() && System.currentTimeMillis() < deadline; }
    }

    private static void flush(Credentials value, long expectedGeneration, long deadline) {
        try {
            TrackingDatabase db = TrackingDatabase.get(context);
            for (String id : db.sessions(value.owner)) {
                while (valid(value, expectedGeneration, deadline)) {
                    JSONArray points = db.batch(value.owner, id);
                    if (points.length() == 0) break;
                    JSONObject body = new JSONObject(); body.put("sessionId", id); body.put("points", points);
                    JSONObject response = post(value, expectedGeneration, deadline, "/api/tracking/points", body);
                    if (response == null || !valid(value, expectedGeneration, deadline)) return;
                    JSONArray ack = response.optJSONArray("ackIds");
                    if (ack == null || db.acknowledge(value.owner, id, points, ack) == 0) {
                        setError("O servidor não confirmou os pontos GPS. A fila foi preservada."); return;
                    }
                    if (response.has("active") && !response.optBoolean("active", true)) {
                        synchronized (LOCK) {
                            if (generation == expectedGeneration && value.owner.equals(owner) && id.equals(sessionId) && service != null && service.isCapturing()) {
                                authorizationLost("Esta sessão GPS foi encerrada no servidor. O registro foi parado.", expectedGeneration, value.owner); return;
                            }
                        }
                    }
                }
                if (!valid(value, expectedGeneration, deadline)) return;
                String stoppedAt = db.stopTime(value.owner, id);
                if (stoppedAt != null && db.batch(value.owner, id).length() == 0) {
                    JSONObject body = new JSONObject(); body.put("sessionId", id); body.put("stoppedAt", stoppedAt);
                    if (post(value, expectedGeneration, deadline, "/api/tracking/stop", body) == null || !valid(value, expectedGeneration, deadline)) return;
                    db.closeSession(value.owner, id);
                }
            }
            synchronized (LOCK) { if (generation == expectedGeneration) error = ""; }
        } catch (Exception ignored) { if (valid(value, expectedGeneration, deadline)) setError("Sem conexão com a API. Os pontos GPS continuam na fila deste usuário."); }
    }

    private static JSONObject post(Credentials value, long expectedGeneration, long deadline, String endpoint, JSONObject body) throws Exception {
        if (!valid(value, expectedGeneration, deadline)) return null;
        HttpsURLConnection request = (HttpsURLConnection) new URI(value.apiUrl + endpoint).toURL().openConnection();
        synchronized (LOCK) {
            if (!valid(value, expectedGeneration, deadline)) { request.disconnect(); return null; }
            connection = request;
        }
        try {
            int timeout = (int) Math.max(1, Math.min(10000, deadline - System.currentTimeMillis()));
            request.setConnectTimeout(timeout); request.setReadTimeout(timeout); request.setInstanceFollowRedirects(false);
            request.setRequestMethod("POST"); request.setRequestProperty("Authorization", "Bearer " + value.token);
            request.setRequestProperty("X-Rota-Tracking-Response", "compact");
            request.setRequestProperty("Content-Type", "application/json; charset=utf-8"); request.setRequestProperty("Accept", "application/json");
            request.setDoOutput(true); byte[] payload = body.toString().getBytes(StandardCharsets.UTF_8); request.setFixedLengthStreamingMode(payload.length);
            if (!valid(value, expectedGeneration, deadline)) return null;
            try (OutputStream output = request.getOutputStream()) { output.write(payload); }
            int code = request.getResponseCode();
            if (code == 401 || code == 403) { authorizationLost("Sua sessão foi encerrada ou perdeu permissão. Entre novamente para enviar os pontos pendentes.", expectedGeneration, value.owner); return null; }
            if (code == 422) {
                authorizationLost("A API recusou o período desta sessão GPS. O registro foi parado e a fila preservada para revisão.", expectedGeneration, value.owner); return null;
            }
            if (!valid(value, expectedGeneration, deadline)) return null;
            if (code != 200) {
                synchronized (LOCK) {
                    if (generation == expectedGeneration && value.owner.equals(owner)) error = "A API não confirmou o envio GPS (HTTP " + code + "). A fila foi preservada.";
                }
                return null;
            }
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            try (InputStream input = request.getInputStream()) {
                byte[] buffer = new byte[4096]; int count;
                while ((count = input.read(buffer)) != -1) {
                    if (!valid(value, expectedGeneration, deadline)) return null;
                    if (bytes.size() + count > 262144) throw new IllegalStateException("Oversized API response");
                    bytes.write(buffer, 0, count);
                }
            }
            return new JSONObject(bytes.toString("UTF-8"));
        } finally {
            synchronized (LOCK) { if (connection == request) connection = null; }
            request.disconnect();
        }
    }

    private static void disconnectLocked() { if (connection != null) { connection.disconnect(); connection = null; } }
}
