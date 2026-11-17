fn main() {
    // From Finder the app gets a minimal PATH; take the login shell's so the agent CLIs can be found
    plyfold_desktop_lib::adopt_login_path();
    plyfold_desktop_lib::run()
}
