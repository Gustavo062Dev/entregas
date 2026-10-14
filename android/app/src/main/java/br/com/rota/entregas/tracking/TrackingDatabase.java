package br.com.rota.entregas.tracking;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import com.getcapacitor.JSObject;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** Private, bounded queue. It deliberately never stores a bearer token. */
final class TrackingDatabase extends SQLiteOpenHelper {
    private static TrackingDatabase instance;
    private static final int MAX_POINTS = 20000;

    static synchronized TrackingDatabase get(Context context) {
        if (instance == null) instance = new TrackingDatabase(context.getApplicationContext());
        return instance;
    }

    private TrackingDatabase(Context context) { super(context, "rota-location.sqlite", null, 1); }

    @Override public void onConfigure(SQLiteDatabase db) { db.setForeignKeyConstraintsEnabled(true); }

    @Override public void onCreate(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE sessions(owner TEXT NOT NULL, id TEXT NOT NULL, driver_id TEXT NOT NULL, started_at TEXT NOT NULL, pending_stop TEXT, last_point TEXT, PRIMARY KEY(owner,id))");
        db.execSQL("CREATE TABLE points(seq INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL, session_id TEXT NOT NULL, id TEXT NOT NULL UNIQUE, latitude REAL NOT NULL, longitude REAL NOT NULL, accuracy REAL NOT NULL, recorded_at TEXT NOT NULL, FOREIGN KEY(owner,session_id) REFERENCES sessions(owner,id) ON DELETE CASCADE)");
        db.execSQL("CREATE INDEX queue_owner_session ON points(owner,session_id,seq)");
        db.execSQL("CREATE TABLE owners(owner TEXT PRIMARY KEY, dropped INTEGER NOT NULL DEFAULT 0)");
    }

    @Override public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
        throw new IllegalStateException("Unsupported location database version");
    }

    synchronized void createSession(String owner, String sessionId, String driverId, String startedAt) {
        SQLiteDatabase db = getWritableDatabase();
        ContentValues value = new ContentValues();
        value.put("owner", owner); value.put("id", sessionId); value.put("driver_id", driverId); value.put("started_at", startedAt);
        db.insertWithOnConflict("sessions", null, value, SQLiteDatabase.CONFLICT_IGNORE);
        db.execSQL("INSERT OR IGNORE INTO owners(owner) VALUES(?)", new Object[] { owner });
    }

    synchronized void enqueue(String owner, String sessionId, JSONObject point) throws JSONException {
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try {
            ContentValues value = new ContentValues();
            value.put("owner", owner); value.put("session_id", sessionId); value.put("id", point.getString("id"));
            value.put("latitude", point.getDouble("latitude")); value.put("longitude", point.getDouble("longitude"));
            value.put("accuracy", point.getDouble("accuracy")); value.put("recorded_at", point.getString("recordedAt"));
            db.insertOrThrow("points", null, value);
            ContentValues latest = new ContentValues(); latest.put("last_point", point.toString());
            db.update("sessions", latest, "owner=? AND id=?", new String[] { owner, sessionId });
            long count;
            try (Cursor cursor = db.rawQuery("SELECT COUNT(*) FROM points", null)) { cursor.moveToFirst(); count = cursor.getLong(0); }
            long excess = count - MAX_POINTS;
            if (excess > 0) {
                try (Cursor cursor = db.rawQuery("SELECT owner,COUNT(*) FROM (SELECT owner FROM points ORDER BY seq LIMIT ?) GROUP BY owner", new String[] { String.valueOf(excess) })) {
                    while (cursor.moveToNext()) db.execSQL("UPDATE owners SET dropped=dropped+? WHERE owner=?", new Object[] { cursor.getLong(1), cursor.getString(0) });
                }
                db.execSQL("DELETE FROM points WHERE seq IN (SELECT seq FROM points ORDER BY seq LIMIT ?)", new Object[] { excess });
            }
            db.setTransactionSuccessful();
        } finally { db.endTransaction(); }
    }

    synchronized void pendingStop(String owner, String sessionId, String stoppedAt) {
        // Keep the first stop instant when multiple stop calls race.
        getWritableDatabase().execSQL("UPDATE sessions SET pending_stop=COALESCE(pending_stop,?) WHERE owner=? AND id=?", new Object[] { stoppedAt, owner, sessionId });
    }

    synchronized void closeSession(String owner, String sessionId) {
        // Called only after every point and the stop request were acknowledged.
        getWritableDatabase().delete("sessions", "owner=? AND id=?", new String[] { owner, sessionId });
    }

    synchronized List<String> sessions(String owner) {
        List<String> result = new ArrayList<>();
        try (Cursor cursor = getReadableDatabase().rawQuery("SELECT id FROM sessions WHERE owner=? ORDER BY started_at,id", new String[] { owner })) {
            while (cursor.moveToNext()) result.add(cursor.getString(0));
        }
        return result;
    }

    synchronized String stopTime(String owner, String sessionId) {
        try (Cursor cursor = getReadableDatabase().rawQuery("SELECT pending_stop FROM sessions WHERE owner=? AND id=?", new String[] { owner, sessionId })) {
            return cursor.moveToFirst() && !cursor.isNull(0) ? cursor.getString(0) : null;
        }
    }

    synchronized JSONArray batch(String owner, String sessionId) throws JSONException {
        JSONArray result = new JSONArray();
        try (Cursor cursor = getReadableDatabase().rawQuery("SELECT id,latitude,longitude,accuracy,recorded_at FROM points WHERE owner=? AND session_id=? ORDER BY seq LIMIT 100", new String[] { owner, sessionId })) {
            while (cursor.moveToNext()) {
                JSONObject point = new JSONObject();
                point.put("id", cursor.getString(0)); point.put("latitude", cursor.getDouble(1)); point.put("longitude", cursor.getDouble(2));
                point.put("accuracy", cursor.getDouble(3)); point.put("recordedAt", cursor.getString(4)); result.put(point);
            }
        }
        return result;
    }

    synchronized int acknowledge(String owner, String sessionId, JSONArray sent, JSONArray ack) throws JSONException {
        // An API response cannot acknowledge another user's rows or unsent IDs.
        java.util.HashSet<String> eligible = new java.util.HashSet<>();
        for (int i = 0; i < sent.length(); i++) eligible.add(sent.getJSONObject(i).getString("id"));
        int removed = 0;
        SQLiteDatabase db = getWritableDatabase(); db.beginTransaction();
        try {
            for (int i = 0; i < ack.length(); i++) {
                String id = ack.optString(i, "");
                if (eligible.remove(id)) removed += db.delete("points", "owner=? AND session_id=? AND id=?", new String[] { owner, sessionId, id });
            }
            db.setTransactionSuccessful();
        } finally { db.endTransaction(); }
        return removed;
    }

    synchronized int pending(String owner) {
        if (owner == null) return 0;
        try (Cursor cursor = getReadableDatabase().rawQuery("SELECT COUNT(*) FROM points WHERE owner=?", new String[] { owner })) { cursor.moveToFirst(); return cursor.getInt(0); }
    }

    synchronized int dropped(String owner) {
        if (owner == null) return 0;
        try (Cursor cursor = getReadableDatabase().rawQuery("SELECT dropped FROM owners WHERE owner=?", new String[] { owner })) { return cursor.moveToFirst() ? cursor.getInt(0) : 0; }
    }

    synchronized JSObject lastPoint(String owner, String sessionId) {
        if (owner == null) return null;
        String sql = sessionId == null ? "SELECT last_point FROM sessions WHERE owner=? AND last_point IS NOT NULL ORDER BY started_at DESC LIMIT 1" : "SELECT last_point FROM sessions WHERE owner=? AND id=?";
        String[] args = sessionId == null ? new String[] { owner } : new String[] { owner, sessionId };
        try (Cursor cursor = getReadableDatabase().rawQuery(sql, args)) {
            if (cursor.moveToFirst() && !cursor.isNull(0)) return new JSObject(cursor.getString(0));
        } catch (JSONException ignored) { /* A malformed metadata row must not expose GPS data in logs. */ }
        return null;
    }

    synchronized void closeOrphans(String owner, String liveSessionId, String stoppedAt) {
        // Process death never restarts capture. Its sessions end on the next authenticated sync.
        if (liveSessionId == null) getWritableDatabase().execSQL("UPDATE sessions SET pending_stop=COALESCE(pending_stop,?) WHERE owner=?", new Object[] { stoppedAt, owner });
        else getWritableDatabase().execSQL("UPDATE sessions SET pending_stop=COALESCE(pending_stop,?) WHERE owner=? AND id<>?", new Object[] { stoppedAt, owner, liveSessionId });
    }
}
