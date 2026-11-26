import sharp from 'sharp';

/* ------------------------------------------------------------------
   GenerateLocationMap
   ------------------------------------------------------------------
   Builds a small static map around a coordinate using OpenStreetMap
   tiles (open data, no API key), stitches them with sharp, and returns
   a PNG buffer with a pin whose TIP sits exactly on the coordinate.

   OSM tile usage policy: identify the client, keep requests small.
   We fetch a 3x3 block at street zoom - nine tiles per certificate.

   ACCURACY NOTE (HEX_MAP_V4): the tiles are resized FIRST and the pin
   is drawn afterwards at the final scale. Compositing the pin before
   the resize made sharp place the overlay at un-scaled coordinates, so
   the pin landed up to ~1.3 km from the real point.

   Returns null on any failure so certificate generation never breaks
   because a tile server was slow.
   ------------------------------------------------------------------- */

const UA = 'RapidLodgements-HexSign/1.0 (esign.rapidlodge.com.au)';

function lon2tile(lon, z) {
  return Math.floor(((lon + 180) / 360) * Math.pow(2, z));
}
function lat2tile(lat, z) {
  const r = (lat * Math.PI) / 180;
  return Math.floor(
    ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * Math.pow(2, z)
  );
}

async function fetchTile(z, x, y, timeoutMs = 4000) {
  const url = `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'image/png' },
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch (e) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// classic teardrop pin; the TIP is at (w/2, h)
function pinSvg(w, h) {
  const cx = w / 2;
  const r = w * 0.34;
  const cy = h * 0.36;
  return Buffer.from(
    `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">
       <ellipse cx="${cx}" cy="${h - 2}" rx="${w * 0.26}" ry="${h * 0.045}" fill="rgba(0,0,0,0.22)"/>
       <path d="M${cx} ${h}
                L${cx - r * 0.62} ${h * 0.58}
                A${r} ${r} 0 1 1 ${cx + r * 0.62} ${h * 0.58} Z"
             fill="#C0392B" stroke="#ffffff" stroke-width="1.6"/>
       <circle cx="${cx}" cy="${cy}" r="${r * 0.40}" fill="#ffffff"/>
     </svg>`
  );
}

export default async function GenerateLocationMap(lat, lng, opts = {}) {
  try {
    const la = Number(lat);
    const lo = Number(lng);
    if (!Number.isFinite(la) || !Number.isFinite(lo)) return null;
    if (Math.abs(la) > 90 || Math.abs(lo) > 180) return null;

    const zoom = opts.zoom || 15;
    const tileSize = 256;
    const grid = 3;                       // 3x3 tiles -> 768x768
    const W = tileSize * grid;
    const outW = Math.round(opts.w || opts.size || 480);
    const outH = Math.round(opts.h || opts.size || outW);

    const xc = lon2tile(lo, zoom);
    const yc = lat2tile(la, zoom);
    const half = Math.floor(grid / 2);

    const jobs = [];
    for (let dy = -half; dy <= half; dy++) {
      for (let dx = -half; dx <= half; dx++) {
        jobs.push(fetchTile(zoom, xc + dx, yc + dy).then((buf) => ({ dx, dy, buf })));
      }
    }
    const tiles = await Promise.all(jobs);
    const ok = tiles.filter((t) => t.buf);
    if (ok.length < 5) return null;       // too many misses - skip the map

    const composites = ok.map((t) => ({
      input: t.buf,
      left: (t.dx + half) * tileSize,
      top: (t.dy + half) * tileSize,
    }));

    // 1. the map alone, then resize it to the requested cover size
    const mapBuf = await sharp({
      create: { width: W, height: W, channels: 3, background: { r: 232, g: 232, b: 232 } },
    })
      .composite(composites)
      .png()
      .toBuffer();

    const scale = Math.max(outW, outH) / W;      // cover
    const bigW = Math.round(W * scale);
    const bigH = Math.round(W * scale);
    const resized = await sharp(mapBuf).resize(bigW, bigH, { fit: 'fill' }).png().toBuffer();

    // 2. exact fractional position of the coordinate inside the tile grid
    const n = Math.pow(2, zoom);
    const fx = ((lo + 180) / 360) * n;
    const latRad = (la * Math.PI) / 180;
    const fy =
      ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
    const pinX = (fx - (xc - half)) * tileSize * scale;
    const pinY = (fy - (yc - half)) * tileSize * scale;

    // 3. crop so the coordinate sits in the middle of the printed map
    const left = Math.min(Math.max(0, Math.round(pinX - outW / 2)), Math.max(0, bigW - outW));
    const top = Math.min(Math.max(0, Math.round(pinY - outH / 2)), Math.max(0, bigH - outH));
    const cropped = await sharp(resized)
      .extract({ left, top, width: outW, height: outH })
      .png()
      .toBuffer();

    // 4. pin drawn at final scale, tip on the coordinate
    const px = pinX - left;
    const py = pinY - top;
    const pw = Math.max(18, Math.round(outW * 0.085));
    const ph = Math.round(pw * 1.35);
    const pinLeft = Math.max(0, Math.min(outW - pw, Math.round(px - pw / 2)));
    const pinTop = Math.max(0, Math.min(outH - ph, Math.round(py - ph)));

    const png = await sharp(cropped)
      .composite([{ input: pinSvg(pw, ph), left: pinLeft, top: pinTop }])
      .png({ compressionLevel: 9 })
      .toBuffer();

    return png;
  } catch (e) {
    console.log('GenerateLocationMap skipped:', e?.message || e);
    return null;
  }
}
