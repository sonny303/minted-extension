#!/usr/bin/env node
// Regenerate the extension's toolbar/panel icons from the approved brand mark.
//
// The mark lives at docs/design-system/design-system-reference/assets/
// logo-forest.png (forest on transparent — the toolbar sits on light Chrome
// chrome, so the forest variant is the right one; logo-white.png is for dark
// surfaces like the webapp sidebar).
//
// Run after the mark changes:  node scripts/generate-icons.mjs
// Requires Pillow:             python3 -c "import PIL"
import { execFileSync } from "node:child_process";

const PY = `
from PIL import Image

SRC = "docs/design-system/design-system-reference/assets/logo-forest.png"
src = Image.open(SRC).convert("RGBA")

# Trim to the mark's actual ink first. A naive resize of the padded source
# renders the glyph small and illegible at 16px.
mark = src.crop(src.getbbox())
w, h = mark.size

for size in (16, 32, 48, 128):
    pad = max(1, round(size * 0.08))   # ~8% breathing room
    box = size - pad * 2
    scale = min(box / w, box / h)      # aspect-preserving; the mark is 4:3
    new = (max(1, round(w * scale)), max(1, round(h * scale)))
    resized = mark.resize(new, Image.LANCZOS)
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    canvas.paste(resized, ((size - new[0]) // 2, (size - new[1]) // 2), resized)
    canvas.save(f"public/icons/icon{size}.png", optimize=True)
    print(f"wrote public/icons/icon{size}.png")
`;

execFileSync("python3", ["-c", PY], { stdio: "inherit" });
