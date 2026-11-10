"""Render assets/icon-192.png and assets/icon-512.png (same drawing as assets/icon.svg).

Run from the repository root: python tools/make_icons.py  (needs Pillow)
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
FONT = ROOT / "assets" / "fonts" / "saira-extrabold-italic.ttf"
SCALE = 4  # supersampling for smooth edges
SIZE = 512 * SCALE

BACKGROUND = "#05090e"
BLUE = "#42baff"
RED = "#ff4640"
TEXT = "#f6f8fc"


def draw_icon() -> Image.Image:
    image = Image.new("RGB", (SIZE, SIZE), BACKGROUND)
    draw = ImageDraw.Draw(image)
    radius, width = 160 * SCALE, 36 * SCALE
    centre = SIZE // 2
    box = [centre - radius - width // 2, centre - radius - width // 2,
           centre + radius + width // 2, centre + radius + width // 2]
    # Angles as in SVG: from 3 o'clock, clockwise. The gauge sweeps 150 -> 390 degrees.
    draw.arc(box, 150, 390, fill=BLUE, width=width)
    draw.arc(box, 342, 390, fill=RED, width=width)
    font = ImageFont.truetype(str(FONT), 96 * SCALE)
    draw.text((centre, 302 * SCALE), "OBD", font=font, fill=TEXT, anchor="ms")
    return image


def main() -> None:
    icon = draw_icon()
    for size in (192, 512):
        icon.resize((size, size), Image.LANCZOS).save(ROOT / "assets" / f"icon-{size}.png", optimize=True)
        print(f"assets/icon-{size}.png")


if __name__ == "__main__":
    main()
