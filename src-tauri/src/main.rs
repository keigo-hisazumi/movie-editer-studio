// Windows のリリース版でコンソールの窓を出さない
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    studio_lib::run()
}
