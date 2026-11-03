use crate::melt::{melt, nearest_source, Settings};
use after_effects as ae;

#[derive(Eq, PartialEq, Hash, Clone, Copy, Debug)]
enum Params {
    Smoothness,
    LimitShift,
    MaxShift,
    Source,
    Threshold,
}

#[derive(Default)]
struct Plugin {}

ae::define_effect!(Plugin, (), Params);

fn slider(min: f32, max: f32, slider_max: f32, dflt: f64, precision: i16) -> ae::FloatSliderDef<'static> {
    ae::FloatSliderDef::setup(|f| {
        f.set_valid_min(min);
        f.set_valid_max(max);
        f.set_slider_min(min);
        f.set_slider_max(slider_max);
        f.set_default(dflt);
        f.set_value(f.default());
        f.set_precision(precision);
    })
}

impl AdobePluginGlobal for Plugin {
    fn params_setup(&self, params: &mut ae::Parameters<Params>, _: InData, _: OutData) -> Result<(), Error> {
        params.add(Params::Smoothness, "Smoothness", slider(0.0, 1000.0, 100.0, 15.0, 1))?;
        params.add(Params::LimitShift, "Limit Shift", ae::CheckBoxDef::setup(|f| {
            f.set_default(true);
            f.set_value(f.default());
        }))?;
        params.add(Params::MaxShift, "Max Shift", slider(0.0, 1000.0, 50.0, 4.0, 1))?;
        params.add(Params::Source, "Lines", ae::PopupDef::setup(|f| {
            f.set_options(&["Alpha", "Dark Pixels"]);
            f.set_default(1);
            f.set_value(f.default());
        }))?;
        params.add(Params::Threshold, "Threshold", slider(1.0, 99.0, 99.0, 50.0, 0))?;
        Ok(())
    }

    fn handle_command(&mut self, cmd: ae::Command, in_data: InData, mut out_data: OutData, params: &mut ae::Parameters<Params>) -> Result<(), ae::Error> {
        match cmd {
            ae::Command::About => {
                out_data.set_return_msg("Line Melt 1.0.0");
            }
            ae::Command::Render { in_layer, mut out_layer } => {
                let scale = f64::from(in_data.downsample_x()).max(1e-6);
                let smooth = params.get(Params::Smoothness)?.as_float_slider()?.value();
                let limit = params.get(Params::LimitShift)?.as_checkbox()?.value();
                let max_shift = params.get(Params::MaxShift)?.as_float_slider()?.value();
                let dark = params.get(Params::Source)?.as_popup()?.value() == 2;
                let threshold = params.get(Params::Threshold)?.as_float_slider()?.value() / 100.0;
                let settings = Settings {
                    smoothness: smooth * scale,
                    max_shift: if limit { Some(max_shift * scale) } else { None },
                    threshold: threshold as f32,
                };
                render(&in_layer, &mut out_layer, dark, &settings)?;
            }
            _ => {}
        }
        Ok(())
    }
}

/// Straight RGBA in 0..1.
fn read(layer: &ae::Layer, x: usize, y: usize, deep: bool) -> [f32; 4] {
    if deep {
        let p = layer.as_pixel16(x, y);
        let k = 1.0 / 32768.0;
        [p.red as f32 * k, p.green as f32 * k, p.blue as f32 * k, p.alpha as f32 * k]
    } else {
        let p = layer.as_pixel8(x, y);
        let k = 1.0 / 255.0;
        [p.red as f32 * k, p.green as f32 * k, p.blue as f32 * k, p.alpha as f32 * k]
    }
}

fn render(in_layer: &ae::Layer, out_layer: &mut ae::Layer, dark: bool, s: &Settings) -> Result<(), ae::Error> {
    let w = in_layer.width().min(out_layer.width());
    let h = in_layer.height().min(out_layer.height());
    let deep = in_layer.bit_depth() == 16;
    let mut px = Vec::with_capacity(w * h);
    for y in 0..h {
        for x in 0..w {
            px.push(read(in_layer, x, y, deep));
        }
    }
    let cov: Vec<f32> = px
        .iter()
        .map(|p| if dark { (1.0 - (0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2])) * p[3] } else { p[3] })
        .collect();
    let new_cov = melt(&cov, w, h, s);
    let src = nearest_source(&cov, w, h, s.threshold);
    for y in 0..h {
        for x in 0..w {
            let i = y * w + x;
            let a = if src[i] == usize::MAX { 0.0 } else { new_cov[i] };
            let c = if src[i] == usize::MAX { [0.0; 4] } else { px[src[i]] };
            if deep {
                let p = out_layer.as_pixel16_mut(x, y);
                let k = 32768.0;
                p.red = (c[0] * k).round() as u16;
                p.green = (c[1] * k).round() as u16;
                p.blue = (c[2] * k).round() as u16;
                p.alpha = (a * k).round() as u16;
            } else {
                let p = out_layer.as_pixel8_mut(x, y);
                let k = 255.0;
                p.red = (c[0] * k).round() as u8;
                p.green = (c[1] * k).round() as u8;
                p.blue = (c[2] * k).round() as u8;
                p.alpha = (a * k).round() as u8;
            }
        }
    }
    Ok(())
}
