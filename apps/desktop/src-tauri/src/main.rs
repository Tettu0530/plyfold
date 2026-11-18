fn main() {
    // WebKitGTK's DMA-BUF renderer draws a blank window on some GPUs (NVIDIA's driver in particular). Turn it off unless
    // the user has set it either way
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        // SAFETY: nothing else runs yet (single-threaded at the very start of main)
        unsafe { std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1") };
    }
    // From Finder (or a desktop launcher) the app gets a minimal PATH; take the login shell's so the agent CLIs can be found
    plyfold_desktop_lib::adopt_login_path();
    plyfold_desktop_lib::run()
}
