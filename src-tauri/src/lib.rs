mod shared_server;
mod tls_cert;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }

      // LAN-shared server (see shared_server.rs's own header comment for the full design).
      // frontend_dist mirrors tauri.conf.json's build.frontendDist verbatim ("../dist",
      // relative to src-tauri/, same as `cargo run`/`npm run tauri dev` are invoked from) --
      // only verified against `npm run tauri dev` this session, matching how Tauri has been
      // used throughout as a testing proxy, not a shipped production bundle. A real bundled
      // build would need this repointed at Tauri's resource dir instead; not done here since
      // there's no way to test that path in this environment.
      let app_data_dir = app.path().app_data_dir().expect("no app data dir available");
      let frontend_dist = std::path::PathBuf::from("../dist");
      shared_server::start(app_data_dir, frontend_dist);

      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
