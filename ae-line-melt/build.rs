use pipl::*;

#[rustfmt::skip]
fn main() {
    for c in ["does_dialog", "threaded_rendering", "catch_panics", "with_premiere"] {
        println!("cargo::rustc-check-cfg=cfg({c})");
    }
    // A panic shows an error in After Effects instead of taking the app down.
    println!("cargo:rustc-cfg=catch_panics");
    let os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    if os != "windows" && os != "macos" {
        return; // core only (tests / examples)
    }
    pipl::plugin_build(vec![
        Property::Kind(PIPLType::AEEffect),
        Property::Name("Line Melt"),
        Property::Category("Stylize"),

        #[cfg(target_os = "windows")]
        Property::CodeWin64X86("EffectMain"),
        #[cfg(target_os = "macos")]
        Property::CodeMacIntel64("EffectMain"),
        #[cfg(target_os = "macos")]
        Property::CodeMacARM64("EffectMain"),

        Property::AE_PiPL_Version { major: 2, minor: 0 },
        Property::AE_Effect_Spec_Version { major: 13, minor: 28 },
        Property::AE_Effect_Version {
            version: 1,
            subversion: 0,
            bugversion: 0,
            stage: Stage::Release,
            build: 0,
        },
        Property::AE_Effect_Info_Flags(0),
        Property::AE_Effect_Global_OutFlags(
            OutFlags::DeepColorAware
        ),
        Property::AE_Effect_Global_OutFlags_2(
            OutFlags2::SupportsThreadedRendering
        ),
        Property::AE_Effect_Match_Name("PIKO LineMelt"),
        Property::AE_Reserved_Info(0),
        Property::AE_Effect_Support_URL("https://github.com/pikoponpoko/butcher"),
    ])
}
