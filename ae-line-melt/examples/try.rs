// cargo run --release --example try -- in.png out.png <smoothness px> <max shift px | none>
use line_melt::melt::{melt, Settings};
fn main() {
    let a: Vec<String> = std::env::args().collect();
    let img = image::open(&a[1]).unwrap().to_luma8();
    let (w, h) = (img.width() as usize, img.height() as usize);
    let cov: Vec<f32> = img.pixels().map(|p| 1.0 - p.0[0] as f32 / 255.0).collect();
    let s = Settings {
        smoothness: a[3].parse().unwrap(),
        max_shift: a[4].parse().ok(),
        threshold: 0.5,
    };
    let t = std::time::Instant::now();
    let out = melt(&cov, w, h, &s);
    eprintln!("{}x{} {:?}", w, h, t.elapsed());
    let buf: Vec<u8> = out.iter().map(|v| (255.0 * (1.0 - v)).round() as u8).collect();
    image::GrayImage::from_raw(w as u32, h as u32, buf).unwrap().save(&a[2]).unwrap();
}
