//! Line Melt core: smooth every outline of a matte along its arc length.
//!
//! 1. Trace the iso-contours of the coverage at `threshold` (marching squares, sub-pixel).
//! 2. Resample each closed outline every 0.5 px and Gaussian-smooth it along its length
//!    (with a shrink-compensating second pass, g + (g - G(g))). Small shapes get a smaller
//!    sigma (perimeter / 2π × 0.35) so dots and eyes keep their shape.
//! 3. Optionally limit how far each point may move from the original outline; the limit
//!    varies smoothly along the outline so it never creates steps or spikes.
//! 4. Fill the smoothed outlines (non-zero winding, 4 sub-rows per pixel, exact horizontal
//!    coverage) to get the new anti-aliased coverage.

#[derive(Clone, Copy, Debug)]
pub struct Settings {
    /// Gaussian sigma along the outline, in pixels.
    pub smoothness: f64,
    /// Maximum distance a point may move from the original outline, in pixels. `None` = no limit.
    pub max_shift: Option<f64>,
    /// Coverage level that counts as the outline (0..1).
    pub threshold: f32,
}

const STEP: f64 = 0.5;

/// Returns new coverage (0..1) for a `w`×`h` coverage image.
pub fn melt(cov: &[f32], w: usize, h: usize, s: &Settings) -> Vec<f32> {
    let loops = trace(cov, w, h, s.threshold);
    let mut out_loops = Vec::with_capacity(loops.len());
    for lp in loops {
        if let Some(p) = smooth_loop(&lp, s) {
            out_loops.push(p);
        }
    }
    fill(&out_loops, w, h)
}

// ---------------------------------------------------------------------------------------------
// Marching squares

fn trace(cov: &[f32], w: usize, h: usize, t: f32) -> Vec<Vec<[f64; 2]>> {
    use std::collections::HashMap;
    let pw = w + 2;
    let ph = h + 2;
    let val = |px: usize, py: usize| -> f32 {
        if px == 0 || py == 0 || px > w || py > h { 0.0 } else { cov[(py - 1) * w + (px - 1)] }
    };
    // crossing point on an edge id
    let point = |id: u64| -> [f64; 2] {
        let horiz = id & 1 == 0;
        let cell = (id >> 1) as usize;
        let x = cell % pw;
        let y = cell / pw;
        let (x1, y1) = if horiz { (x + 1, y) } else { (x, y + 1) };
        let a = val(x, y);
        let b = val(x1, y1);
        let f = if (b - a).abs() < 1e-12 { 0.5 } else { ((t - a) / (b - a)).clamp(0.0, 1.0) as f64 };
        // padded index p is pixel p-1, whose centre is at p-0.5
        let xa = x as f64 - 0.5;
        let ya = y as f64 - 0.5;
        if horiz { [xa + f, ya] } else { [xa, ya + f] }
    };
    let hid = |x: usize, y: usize| ((y * pw + x) as u64) << 1;
    let vid = |x: usize, y: usize| (((y * pw + x) as u64) << 1) | 1;

    let mut next: HashMap<u64, u64> = HashMap::new();
    for y in 0..ph - 1 {
        for x in 0..pw - 1 {
            let c = [val(x, y), val(x + 1, y), val(x + 1, y + 1), val(x, y + 1)];
            let ins = [c[0] >= t, c[1] >= t, c[2] >= t, c[3] >= t];
            if ins.iter().all(|&b| b) || ins.iter().all(|&b| !b) {
                continue;
            }
            // clockwise edges: top, right, bottom, left (from corner i to corner i+1)
            let edges = [hid(x, y), vid(x + 1, y), hid(x, y + 1), vid(x, y)];
            // (edge id, is_exit)
            let mut cr: [(u64, bool); 4] = [(0, false); 4];
            let mut n = 0;
            for i in 0..4 {
                let a = ins[i];
                let b = ins[(i + 1) % 4];
                if a != b {
                    cr[n] = (edges[i], a && !b);
                    n += 1;
                }
            }
            let saddle = n == 4;
            let pair_outside = saddle && (c.iter().sum::<f32>() * 0.25 >= t);
            // pair inside runs: enter -> next exit (clockwise); outside runs: exit -> next enter.
            // Segment always goes exit -> its paired enter.
            for i in 0..n {
                let (id, exit) = cr[i];
                let (nid, nexit) = cr[(i + 1) % n];
                if !pair_outside {
                    if !exit && nexit {
                        next.insert(nid, id);
                    }
                } else if exit && !nexit {
                    next.insert(id, nid);
                }
            }
        }
    }
    let mut loops = Vec::new();
    let keys: Vec<u64> = next.keys().copied().collect();
    let mut seen = std::collections::HashSet::new();
    for k in keys {
        if seen.contains(&k) {
            continue;
        }
        let mut lp = Vec::new();
        let mut cur = k;
        loop {
            if !seen.insert(cur) {
                break;
            }
            lp.push(point(cur));
            match next.get(&cur) {
                Some(&n) => cur = n,
                None => break,
            }
        }
        if lp.len() >= 3 {
            loops.push(lp);
        }
    }
    loops
}

// ---------------------------------------------------------------------------------------------
// Smoothing along the outline

fn resample(c: &[[f64; 2]]) -> (Vec<[f64; 2]>, f64) {
    let n0 = c.len();
    let mut cum = Vec::with_capacity(n0 + 1);
    cum.push(0.0);
    for i in 0..n0 {
        let a = c[i];
        let b = c[(i + 1) % n0];
        cum.push(cum[i] + ((b[0] - a[0]).powi(2) + (b[1] - a[1]).powi(2)).sqrt());
    }
    let l = cum[n0];
    let n = ((l / STEP) as usize).max(8);
    let mut out = Vec::with_capacity(n);
    let mut j = 0;
    for k in 0..n {
        let u = l * k as f64 / n as f64;
        while j + 1 < n0 && cum[j + 1] <= u {
            j += 1;
        }
        let seg = cum[j + 1] - cum[j];
        let f = if seg > 1e-12 { (u - cum[j]) / seg } else { 0.0 };
        let a = c[j];
        let b = c[(j + 1) % n0];
        out.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]);
    }
    (out, l)
}

fn smooth_loop(c: &[[f64; 2]], s: &Settings) -> Option<Vec<[f64; 2]>> {
    let (p0, l) = resample(c);
    let r = l / (2.0 * std::f64::consts::PI);
    let sg = s.smoothness.min(r * 0.35) / STEP; // in samples
    if sg <= 0.5 {
        return Some(p0);
    }
    let g = gauss_wrap2(&p0, sg);
    let gg = gauss_wrap2(&g, sg);
    let mut p: Vec<[f64; 2]> = g.iter().zip(&gg).map(|(a, b)| [2.0 * a[0] - b[0], 2.0 * a[1] - b[1]]).collect();
    if let Some(maxd) = s.max_shift {
        let n = p.len();
        let mut f = vec![0.0; n];
        for i in 0..n {
            let dx = p[i][0] - p0[i][0];
            let dy = p[i][1] - p0[i][1];
            let m = (dx * dx + dy * dy).sqrt();
            f[i] = (maxd / m.max(1e-6)).min(1.0);
        }
        let kk = (sg as usize).max(2);
        let f = gauss_wrap1(&min_wrap(&f, kk), kk as f64);
        for i in 0..n {
            p[i][0] = p0[i][0] + (p[i][0] - p0[i][0]) * f[i];
            p[i][1] = p0[i][1] + (p[i][1] - p0[i][1]) * f[i];
        }
    }
    Some(p)
}

fn kernel(sigma: f64) -> Vec<f64> {
    let r = (4.0 * sigma + 0.5) as isize;
    let mut k: Vec<f64> = (-r..=r).map(|i| (-(i * i) as f64 / (2.0 * sigma * sigma)).exp()).collect();
    let s: f64 = k.iter().sum();
    k.iter_mut().for_each(|v| *v /= s);
    k
}

fn gauss_wrap1(v: &[f64], sigma: f64) -> Vec<f64> {
    let n = v.len() as isize;
    let k = kernel(sigma);
    let r = (k.len() / 2) as isize;
    (0..n)
        .map(|i| k.iter().enumerate().map(|(j, w)| w * v[(i + j as isize - r).rem_euclid(n) as usize]).sum())
        .collect()
}

fn gauss_wrap2(v: &[[f64; 2]], sigma: f64) -> Vec<[f64; 2]> {
    let n = v.len() as isize;
    let k = kernel(sigma);
    let r = (k.len() / 2) as isize;
    (0..n)
        .map(|i| {
            let mut a = [0.0; 2];
            for (j, w) in k.iter().enumerate() {
                let q = v[(i + j as isize - r).rem_euclid(n) as usize];
                a[0] += w * q[0];
                a[1] += w * q[1];
            }
            a
        })
        .collect()
}

/// Minimum over a window of ±r samples, wrapping around (monotonic deque).
fn min_wrap(v: &[f64], r: usize) -> Vec<f64> {
    let n = v.len();
    if 2 * r + 1 >= n {
        let m = v.iter().cloned().fold(f64::INFINITY, f64::min);
        return vec![m; n];
    }
    let at = |i: isize| v[i.rem_euclid(n as isize) as usize];
    let mut out = vec![0.0; n];
    let mut dq: std::collections::VecDeque<isize> = std::collections::VecDeque::new();
    let r = r as isize;
    for i in -r..(n as isize + r) {
        while let Some(&b) = dq.back() {
            if at(b) >= at(i) { dq.pop_back(); } else { break; }
        }
        dq.push_back(i);
        let c = i - r; // window centre
        if c >= 0 {
            while let Some(&f) = dq.front() {
                if f < c - r { dq.pop_front(); } else { break; }
            }
            out[c as usize] = at(*dq.front().unwrap());
        }
    }
    out
}

// ---------------------------------------------------------------------------------------------
// Filling

const SUB: usize = 4;

fn fill(loops: &[Vec<[f64; 2]>], w: usize, h: usize) -> Vec<f32> {
    let rows = h * SUB;
    let mut xs: Vec<Vec<(f64, i32)>> = vec![Vec::new(); rows];
    for lp in loops {
        let n = lp.len();
        for i in 0..n {
            let a = lp[i];
            let b = lp[(i + 1) % n];
            if a[1] == b[1] {
                continue;
            }
            let dir = if b[1] > a[1] { 1 } else { -1 };
            let (lo, hi) = if a[1] < b[1] { (a, b) } else { (b, a) };
            // sub-row s has centre y = (s + 0.5) / SUB
            let s0 = ((lo[1] * SUB as f64 - 0.5).ceil()).max(0.0) as isize;
            let s1 = ((hi[1] * SUB as f64 - 0.5).ceil()).min(rows as f64) as isize;
            for s in s0..s1 {
                let y = (s as f64 + 0.5) / SUB as f64;
                let x = lo[0] + (hi[0] - lo[0]) * (y - lo[1]) / (hi[1] - lo[1]);
                xs[s as usize].push((x, dir));
            }
        }
    }
    let mut out = vec![0.0f32; w * h];
    let wgt = 1.0 / SUB as f64;
    let mut acc = vec![0.0f64; w];
    for y in 0..h {
        acc.iter_mut().for_each(|v| *v = 0.0);
        for k in 0..SUB {
            let row = &mut xs[y * SUB + k];
            if row.is_empty() {
                continue;
            }
            row.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
            let mut wind = 0;
            for i in 0..row.len() {
                let was = wind;
                wind += row[i].1;
                if was == 0 && wind != 0 {
                    // span starts; find where it ends
                    let xa = row[i].0;
                    let mut wnd = wind;
                    let mut j = i + 1;
                    while j < row.len() {
                        wnd += row[j].1;
                        if wnd == 0 { break; }
                        j += 1;
                    }
                    let xb = if j < row.len() { row[j].0 } else { w as f64 };
                    add_span(&mut acc, xa, xb, wgt);
                }
            }
        }
        for x in 0..w {
            out[y * w + x] = acc[x].clamp(0.0, 1.0) as f32;
        }
    }
    out
}

fn add_span(acc: &mut [f64], xa: f64, xb: f64, wgt: f64) {
    let w = acc.len() as f64;
    let xa = xa.clamp(0.0, w);
    let xb = xb.clamp(0.0, w);
    if xb <= xa {
        return;
    }
    let ia = xa.floor() as usize;
    let ib = xb.floor() as usize;
    if ia == ib {
        if ia < acc.len() { acc[ia] += (xb - xa) * wgt; }
        return;
    }
    acc[ia] += (ia as f64 + 1.0 - xa) * wgt;
    for x in ia + 1..ib {
        acc[x] += wgt;
    }
    if ib < acc.len() {
        acc[ib] += (xb - ib as f64) * wgt;
    }
}

// ---------------------------------------------------------------------------------------------
// Colour: every pixel takes the colour of the nearest original line pixel.

/// Returns, for each pixel, the index of the nearest pixel whose coverage is >= `t`
/// (approximate Euclidean, two-pass propagation). `usize::MAX` if there is none.
pub fn nearest_source(cov: &[f32], w: usize, h: usize, t: f32) -> Vec<usize> {
    let mut src = vec![usize::MAX; w * h];
    let mut d2 = vec![f64::INFINITY; w * h];
    for i in 0..w * h {
        if cov[i] >= t {
            src[i] = i;
            d2[i] = 0.0;
        }
    }
    let dist = |i: usize, s: usize| {
        let dx = (i % w) as f64 - (s % w) as f64;
        let dy = (i / w) as f64 - (s / w) as f64;
        dx * dx + dy * dy
    };
    let fwd: [(isize, isize); 4] = [(-1, 0), (-1, -1), (0, -1), (1, -1)];
    for pass in 0..2 {
        let ys: Vec<usize> = if pass == 0 { (0..h).collect() } else { (0..h).rev().collect() };
        for &y in &ys {
            let xs: Vec<usize> = if pass == 0 { (0..w).collect() } else { (0..w).rev().collect() };
            for &x in &xs {
                let i = y * w + x;
                for &(dx, dy) in &fwd {
                    let (dx, dy) = if pass == 0 { (dx, dy) } else { (-dx, -dy) };
                    let nx = x as isize + dx;
                    let ny = y as isize + dy;
                    if nx < 0 || ny < 0 || nx >= w as isize || ny >= h as isize {
                        continue;
                    }
                    let s = src[ny as usize * w + nx as usize];
                    if s == usize::MAX {
                        continue;
                    }
                    let d = dist(i, s);
                    if d < d2[i] {
                        d2[i] = d;
                        src[i] = s;
                    }
                }
            }
        }
    }
    src
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ring(w: usize, r0: f64, r1: f64, wobble: f64) -> Vec<f32> {
        let c = w as f64 / 2.0;
        (0..w * w)
            .map(|i| {
                let x = (i % w) as f64 + 0.5 - c;
                let y = (i / w) as f64 + 0.5 - c;
                let r = (x * x + y * y).sqrt() + wobble * (y.atan2(x) * 24.0).sin();
                if r >= r0 && r <= r1 { 1.0 } else { 0.0 }
            })
            .collect()
    }

    fn area(v: &[f32]) -> f64 {
        v.iter().map(|&a| a as f64).sum()
    }

    #[test]
    fn no_smoothing_keeps_shape() {
        let a = ring(120, 30.0, 40.0, 0.0);
        let s = Settings { smoothness: 0.0, max_shift: None, threshold: 0.5 };
        let b = melt(&a, 120, 120, &s);
        let diff: f64 = a.iter().zip(&b).map(|(x, y)| (x - y).abs() as f64).sum();
        assert!(diff / area(&a) < 0.05, "diff {}", diff / area(&a));
        // hole stays empty
        assert!(b[60 * 120 + 60] < 0.01);
    }

    #[test]
    fn smoothing_removes_wobble_and_keeps_hole() {
        let a = ring(160, 40.0, 52.0, 2.5);
        let clean = ring(160, 40.0, 52.0, 0.0);
        let s = Settings { smoothness: 12.0, max_shift: None, threshold: 0.5 };
        let b = melt(&a, 160, 160, &s);
        let err = |v: &[f32]| v.iter().zip(&clean).map(|(x, y)| (x - y).abs() as f64).sum::<f64>();
        assert!(err(&b) < err(&a) * 0.5, "{} vs {}", err(&b), err(&a));
        assert!(b[80 * 160 + 80] < 0.01);
    }

    #[test]
    fn max_shift_limits_movement() {
        let a = ring(160, 40.0, 52.0, 4.0);
        let s = Settings { smoothness: 30.0, max_shift: Some(1.0), threshold: 0.5 };
        let b = melt(&a, 160, 160, &s);
        let diff: f64 = a.iter().zip(&b).map(|(x, y)| (x - y).abs() as f64).sum();
        let free = melt(&a, 160, 160, &Settings { max_shift: None, ..s });
        let diff_free: f64 = a.iter().zip(&free).map(|(x, y)| (x - y).abs() as f64).sum();
        assert!(diff < diff_free * 0.6);
    }
}
