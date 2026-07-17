from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "public" / "icons"
OUTPUT.mkdir(parents=True, exist_ok=True)

for size in (192, 512):
    image = Image.new("RGB", (size, size), "#06100c")
    draw = ImageDraw.Draw(image)
    margin = round(size * 0.12)
    draw.rounded_rectangle(
        (margin, margin, size - margin, size - margin),
        radius=round(size * 0.20),
        fill="#0b2b1e",
        outline="#61e6a0",
        width=max(4, round(size * 0.025)),
    )
    points = [
        (size * 0.24, size * 0.54),
        (size * 0.37, size * 0.54),
        (size * 0.44, size * 0.33),
        (size * 0.56, size * 0.70),
        (size * 0.64, size * 0.49),
        (size * 0.76, size * 0.49),
    ]
    draw.line(points, fill="#61e6a0", width=max(8, round(size * 0.045)), joint="curve")
    image.save(OUTPUT / f"run-durability-{size}.png", optimize=True)
