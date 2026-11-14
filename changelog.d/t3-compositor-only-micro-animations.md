### Changed

- The surfaces of the app move on the graphics card. A message, a menu, a drawer, a popover or a
  status change now animates with opacity and transform only, so the browser paints them without
  laying out the page again. The blur that used to soften these surfaces while they moved is gone:
  a blur is redrawn on every frame of the movement, and on a long thread that cost frames that the
  reader could see.
- The motion of the app is one curve now, a short spring of 150 to 180 milliseconds. Every menu,
  popover, panel and message that appears or leaves uses it, so they all arrive the same way.
- The sticky bar over a scrolling thread no longer blurs what it covers. It sits on a clean
  translucent fill instead, so scrolling under it stays smooth.
