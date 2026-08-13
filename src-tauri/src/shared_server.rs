// LAN-shared local server for the Tauri desktop app (see clinux-mobile-sync-multiuser-video-
// roadmap memory note, Phase B-E follow-up request #1). Serves the SAME built frontend other
// devices on the clinic's WiFi can load in their own browser, backed by a SQLite database (WAL
// mode -- real concurrent reads + serialized writes, not per-device localStorage) that every
// connected device shares. This is a genuinely different model from Phase C's QR/text-key
// transfer: that's an explicit, session-scoped, offline-capable handoff between two devices;
// this is a live, always-on shared store for as long as the Tauri host machine is running and
// devices stay on the same network. Both can coexist -- a device that's briefly off the LAN (or
// syncing to a DIFFERENT clinic entirely) still has the QR/text-key path available.
//
// Auth reuses clinuxflow-api's own JWT scheme exactly (HS256, payload {sub, clinicId, email,
// iat, exp} -- see clinuxflow-api/src/lib/session.js) rather than inventing a new one, so the
// SAME session token clinux-frontend already carries from a normal login works here unchanged.
// This does mean the Tauri host needs the same JWT_SECRET clinuxflow-api uses, configured via
// the CLINUX_JWT_SECRET env var at Tauri startup -- there is no network call to clinuxflow-api
// to verify a token, by design: a LAN-local server needs to keep working even if the clinic's
// internet is briefly down.
use axum::{
    body::Body,
    extract::{Path, State},
    http::{header, HeaderMap, Request, StatusCode},
    response::{Html, IntoResponse, Response},
    routing::{get, put},
    Json, Router,
};
use jsonwebtoken::{decode, Algorithm, DecodingKey, Validation};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    convert::Infallible,
    net::SocketAddr,
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tower::{service_fn, Service, ServiceExt};
use tower_http::{cors::CorsLayer, services::ServeDir};

pub const SHARED_SERVER_PORT: u16 = 47856;

#[derive(Clone)]
struct AppState {
    db: Arc<Mutex<Connection>>,
    jwt_secret: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct Claims {
    sub: String,
    #[serde(rename = "clinicId")]
    clinic_id: String,
    email: String,
    #[allow(dead_code)]
    iat: usize,
    #[allow(dead_code)]
    exp: usize,
}

#[derive(Debug, Serialize)]
struct ErrorBody {
    success: bool,
    error: String,
}

fn unauthorized() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        Json(ErrorBody { success: false, error: "Unauthorized".into() }),
    )
        .into_response()
}

// Mirrors clinuxflow-api's requireUser() middleware exactly (same secret, same HS256 scheme,
// same claim shape) -- see this file's own header comment for why that's deliberate, not a
// coincidence.
fn verify_bearer(headers: &HeaderMap, secret: &str) -> Result<Claims, Response> {
    let raw = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let token = raw.strip_prefix("Bearer ").ok_or_else(unauthorized)?;
    let key = DecodingKey::from_secret(secret.as_bytes());
    let validation = Validation::new(Algorithm::HS256);
    decode::<Claims>(token, &key, &validation)
        .map(|data| data.claims)
        .map_err(|_| unauthorized())
}

fn open_db(app_data_dir: &PathBuf) -> Connection {
    std::fs::create_dir_all(app_data_dir).expect("could not create app data dir for shared DB");
    let db_path = app_data_dir.join("clinux-shared.sqlite3");
    let conn = Connection::open(&db_path).expect("could not open shared SQLite database");
    // WAL mode is what actually gives this "concurrency supported": readers never block writers
    // and vice versa, unlike SQLite's default rollback journal mode. busy_timeout backstops the
    // rare writer-vs-writer collision (two devices saving at the exact same instant) by making
    // the second writer wait briefly and retry instead of failing outright.
    conn.pragma_update(None, "journal_mode", "WAL").expect("failed to enable WAL mode");
    conn.pragma_update(None, "busy_timeout", 5000i64).expect("failed to set busy_timeout");
    conn.execute(
        "CREATE TABLE IF NOT EXISTS records (
            collection TEXT NOT NULL,
            id TEXT NOT NULL,
            clinic_id TEXT NOT NULL,
            data TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (collection, id)
        )",
        [],
    )
    .expect("failed to create records table");
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_records_collection_clinic ON records (collection, clinic_id)",
        [],
    )
    .expect("failed to create records index");
    conn
}

async fn health() -> impl IntoResponse {
    Json(serde_json::json!({ "status": "ok", "service": "clinux-shared-server" }))
}

// Every row in one collection, scoped to the CALLER's own clinicId from their JWT -- never a
// client-supplied value, so there's no query-param way to peek at another clinic's data even if
// you guessed its id. Mirrors formData.js's own currentClinicId() scoping, just enforced
// server-side now that multiple devices share one database instead of each having an isolated
// localStorage no other device could reach anyway.
async fn list_collection(
    State(state): State<AppState>,
    Path(name): Path<String>,
    headers: HeaderMap,
) -> Response {
    let claims = match verify_bearer(&headers, &state.jwt_secret) {
        Ok(c) => c,
        Err(resp) => return resp,
    };
    let db = state.db.lock().unwrap();
    let mut stmt = match db.prepare("SELECT data FROM records WHERE collection = ?1 AND clinic_id = ?2") {
        Ok(s) => s,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let rows = stmt.query_map(rusqlite::params![name, claims.clinic_id], |row| {
        row.get::<_, String>(0)
    });
    let rows = match rows {
        Ok(r) => r,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let mut out: Vec<Value> = Vec::new();
    for r in rows {
        match r {
            Ok(json_text) => match serde_json::from_str::<Value>(&json_text) {
                Ok(v) => out.push(v),
                Err(_) => continue,
            },
            Err(_) => continue,
        }
    }
    Json(out).into_response()
}

// Upserts one row by (collection, id) -- the id in the URL is authoritative, not anything in the
// body, so a client can never overwrite a different row than the one it addressed. clinicId is
// always the CALLER's own (from the JWT), regardless of what the body claims, matching
// clinuxflow-api's own POST /api/auth/invite convention of never trusting a client-supplied
// clinicId for a write.
async fn upsert_record(
    State(state): State<AppState>,
    Path((name, id)): Path<(String, String)>,
    headers: HeaderMap,
    Json(mut body): Json<Value>,
) -> Response {
    let claims = match verify_bearer(&headers, &state.jwt_secret) {
        Ok(c) => c,
        Err(resp) => return resp,
    };
    if let Value::Object(ref mut map) = body {
        map.insert("clinicId".to_string(), Value::String(claims.clinic_id.clone()));
        map.insert("id".to_string(), Value::String(id.clone()));
    }
    let data = match serde_json::to_string(&body) {
        Ok(s) => s,
        Err(_) => return StatusCode::BAD_REQUEST.into_response(),
    };
    let now = chrono::Utc::now().to_rfc3339();
    let db = state.db.lock().unwrap();
    let result = db.execute(
        "INSERT INTO records (collection, id, clinic_id, data, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(collection, id) DO UPDATE SET data = excluded.data, clinic_id = excluded.clinic_id, updated_at = excluded.updated_at",
        rusqlite::params![name, id, claims.clinic_id, data, now],
    );
    match result {
        Ok(_) => StatusCode::OK.into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

// Scoped by clinic_id in the WHERE clause too, not just collection+id -- deleting a row you
// don't own (a guessed/replayed id from a different clinic) silently affects zero rows instead
// of succeeding.
async fn delete_record(
    State(state): State<AppState>,
    Path((name, id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Response {
    let claims = match verify_bearer(&headers, &state.jwt_secret) {
        Ok(c) => c,
        Err(resp) => return resp,
    };
    let db = state.db.lock().unwrap();
    let result = db.execute(
        "DELETE FROM records WHERE collection = ?1 AND id = ?2 AND clinic_id = ?3",
        rusqlite::params![name, id, claims.clinic_id],
    );
    match result {
        Ok(_) => StatusCode::OK.into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

// Reads + serves index.html with one injected marker script, for any request ServeDir couldn't
// resolve to a real static file -- covers both "/" itself and every vue-router history-mode
// path (/clinic-home, /front-desk, ...), which don't exist as real files on disk. The injected
// global is how the frontend's collection layer knows to talk to THIS server's /api/collections
// instead of staying purely local-first -- see src/data/collectionFactory.js.
async fn serve_injected_index(index_path: PathBuf) -> Result<Response, Infallible> {
    let html = match tokio::fs::read_to_string(&index_path).await {
        Ok(h) => h,
        Err(_) => return Ok((StatusCode::NOT_FOUND, "index.html not found").into_response()),
    };
    let injected = html.replacen(
        "<head>",
        "<head><script>window.__CLINUX_SHARED_SERVER__ = true;</script>",
        1,
    );
    Ok(Html(injected).into_response())
}

fn build_router(state: AppState, frontend_dist: PathBuf) -> Router {
    let index_path = frontend_dist.join("index.html");
    // append_index_html_on_directories(false): ServeDir's default behavior serves a directory's
    // index.html directly for the "/" request specifically, bypassing this whole not-found path
    // -- which means the shared-mode marker script would never get injected for the app's own
    // root URL, only for deeper client-routed paths like /clinic-home. Disabling it makes "/"
    // ALSO fall through below, so every route -- "/" included -- consistently gets it.
    let serve_dir = ServeDir::new(frontend_dist).append_index_html_on_directories(false);

    // NOT using ServeDir::not_found_service here deliberately -- tower_http hard-codes that
    // wrapper to force the response status to 404 (SetStatus::new(_, StatusCode::NOT_FOUND) in
    // its own source), which is correct for "serve a literal not-found page" but wrong for SPA
    // client-side-routing fallback: a real page like /clinic-home would come back as an HTTP 404
    // even though the body is the actual working app shell, which both litters the browser
    // console with false failures and is the kind of status code a crawler/proxy could act on
    // incorrectly. Instead: try ServeDir first (real files -- JS/CSS/images -- pass through with
    // their real 200), and only when IT reports 404 do we discard that and serve the injected
    // index.html with a genuine 200 of our own.
    let index_fallback = service_fn(move |req: Request<Body>| {
        let mut serve_dir = serve_dir.clone();
        let index_path = index_path.clone();
        Box::pin(async move {
            let resp = ServiceExt::<Request<Body>>::ready(&mut serve_dir)
                .await
                .expect("ServeDir::poll_ready is infallible")
                .call(req)
                .await
                .expect("ServeDir::call is infallible");
            if resp.status() == StatusCode::NOT_FOUND {
                serve_injected_index(index_path).await
            } else {
                Ok(resp.into_response())
            }
        })
    });

    let cors = CorsLayer::new()
        .allow_origin(tower_http::cors::Any)
        .allow_methods(tower_http::cors::Any)
        .allow_headers(tower_http::cors::Any);

    let api = Router::new()
        .route("/api/health", get(health))
        .route("/api/collections/{name}", get(list_collection))
        .route("/api/collections/{name}/{id}", put(upsert_record).delete(delete_record))
        .layer(cors)
        .with_state(state);

    api.fallback_service(index_fallback)
}

/// Starts the shared LAN server. Silently does nothing (logs and returns) if CLINUX_JWT_SECRET
/// isn't configured -- same fail-closed convention clinuxflow-api's own auth middleware uses,
/// rather than ever standing up a local server nobody can safely authenticate against.
pub fn start(app_data_dir: PathBuf, frontend_dist: PathBuf) {
    let jwt_secret = match std::env::var("CLINUX_JWT_SECRET") {
        Ok(s) if !s.is_empty() => s,
        _ => {
            log::warn!("CLINUX_JWT_SECRET not set -- shared LAN server not started");
            return;
        }
    };

    tauri::async_runtime::spawn(async move {
        let db = open_db(&app_data_dir);
        let state = AppState { db: Arc::new(Mutex::new(db)), jwt_secret };
        let app = build_router(state, frontend_dist);

        let addr = SocketAddr::from(([0, 0, 0, 0], SHARED_SERVER_PORT));
        let listener = match tokio::net::TcpListener::bind(addr).await {
            Ok(l) => l,
            Err(e) => {
                log::error!("shared LAN server: could not bind {addr}: {e}");
                return;
            }
        };

        let lan_ip = local_ip_address::local_ip()
            .map(|ip| ip.to_string())
            .unwrap_or_else(|_| "<unknown>".to_string());
        log::info!("shared LAN server listening on http://{lan_ip}:{SHARED_SERVER_PORT} (and http://localhost:{SHARED_SERVER_PORT})");

        if let Err(e) = axum::serve(listener, app).await {
            log::error!("shared LAN server stopped: {e}");
        }
    });
}
