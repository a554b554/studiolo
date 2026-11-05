fn main() {
    // The client's build number within its version (`build` in desktop/package.json, CHANGELOG.md):
    // update_client sends it, so the server can offer a newer build of the same version.
    println!("cargo:rerun-if-changed=../package.json");
    let package = std::fs::read_to_string("../package.json").expect("desktop/package.json");
    let build: u32 = package
        .split("\"build\":")
        .nth(1)
        .and_then(|rest| rest.trim_start().split(|c: char| !c.is_ascii_digit()).next())
        .and_then(|digits| digits.parse().ok())
        .expect("a numeric \"build\" in desktop/package.json");
    println!("cargo:rustc-env=STUDIOLO_BUILD={build}");

    // App commands with their own permissions: the launcher may trust origins, and server pages
    // (remote origins, capabilities/servers.json) may record, read the build, name servers, set
    // how links open and update the client.
    let commands = &["trust_origins", "known_servers", "link_mode", "set_link_mode", "open_link", "start_recording", "start_streaming", "stop_recording", "cancel_recording", "client_build", "update_client"];
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(commands)))
        .expect("failed to run tauri-build");
}
