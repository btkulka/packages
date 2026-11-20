import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { carouselsIn, imageLine, imageRun, pickedAt, picksIn, pickText, setKey } from "./picks.js";
import type { ChatItem } from "../types.js";

const claude = (id: string, text: string): ChatItem => ({ kind: "claude", id, text });
const you = (id: string, text: string): ChatItem => ({ kind: "you", id, text });
const refs = (pics: { ref: string }[] | undefined) => pics?.map((p) => p.ref);

describe("imageLine", () => {
  it("reads a line that's only an image, its alt and address", () => {
    assert.deepEqual(imageLine("![A misty harbor](D:\\renders\\harbor.png)"), [{ ref: "D:\\renders\\harbor.png", alt: "A misty harbor" }]);
  });

  it("reads several on one line, and an address in <…> or with a title", () => {
    assert.deepEqual(refs(imageLine('  ![a](<D:/x y/a.png>) ![b](https://e.com/b.jpg "B")  ')), ["D:/x y/a.png", "https://e.com/b.jpg"]);
  });

  it("leaves out an empty alt", () => {
    assert.deepEqual(imageLine("![](a.png)"), [{ ref: "a.png", alt: undefined }]);
  });

  it("isn't a line with words besides the images, a list item, or a table row", () => {
    assert.equal(imageLine("Here: ![a](a.png)"), undefined);
    assert.equal(imageLine("![a](a.png) is the first"), undefined);
    assert.equal(imageLine("- ![a](a.png)"), undefined);
    assert.equal(imageLine("| ![a](a.png) | ![b](b.png) |"), undefined);
    assert.equal(imageLine(""), undefined);
  });
});

describe("imageRun", () => {
  it("takes image lines in a row, blank lines between them allowed, and ends at the last image", () => {
    const lines = ["![a](a.png)", "", "![b](b.png)", "![c](c.png)", "", "Which one?"];
    const run = imageRun(lines, 0);
    assert.deepEqual(refs(run?.pics), ["a.png", "b.png", "c.png"]);
    assert.equal(run?.end, 3);
  });

  it("stops at the first line that isn't images", () => {
    const run = imageRun(["![a](a.png)", "Some words", "![b](b.png)"], 0);
    assert.deepEqual(refs(run?.pics), ["a.png"]);
    assert.equal(run?.end, 0);
  });

  it("isn't a run from a line that isn't images", () => {
    assert.equal(imageRun(["Text", "![a](a.png)"], 0), undefined);
  });
});

describe("carouselsIn", () => {
  it("finds each run of two or more images, and leaves a single image alone", () => {
    const text = ["Two looks:", "![one](1.png)", "![two](2.png)", "", "A detail:", "", "![close-up](3.png)", "", "And again:", "![x](x.png) ![y](y.png)"].join("\n");
    assert.deepEqual(carouselsIn(text).map(refs), [
      ["1.png", "2.png"],
      ["x.png", "y.png"],
    ]);
  });

  it("skips images in code blocks, even one that isn't closed yet", () => {
    assert.deepEqual(carouselsIn("```md\n![a](a.png)\n![b](b.png)\n```"), []);
    assert.deepEqual(carouselsIn("```\n![a](a.png)\n![b](b.png)"), []);
  });
});

describe("pickText", () => {
  const pics = [
    { ref: "D:\\renders\\a.png", alt: "Warm dusk" },
    { ref: "https://e.com/b.png", alt: "  Cold dawn " },
    { ref: "c.png" },
    { ref: "data:image/png;base64,AAAA", alt: "Inline" },
  ];

  it("says which, of how many, its alt and its address", () => {
    assert.equal(pickText(pics, 0), "Picked 1 of 4: Warm dusk (D:\\renders\\a.png)");
    assert.equal(pickText(pics, 1), "Picked 2 of 4: Cold dawn (https://e.com/b.png)");
  });

  it("goes without an alt it hasn't got, and without a data: address", () => {
    assert.equal(pickText(pics, 2), "Picked 3 of 4 (c.png)");
    assert.equal(pickText(pics, 3), "Picked 4 of 4: Inline");
  });
});

describe("picksIn / pickedAt", () => {
  const reply = claude("c1", "Three directions:\n\n![Warm](a.png)\n\n![Cold](b.png)\n\n![Neon](c.png)\n\nPick one.");
  const set = carouselsIn((reply as { text: string }).text)[0];

  it("reads the pick from Ben's later message, as Pick sends it", () => {
    const picks = picksIn([reply, you("y1", pickText(set, 1))]);
    assert.equal(picks.get(setKey(set)), "b.png");
    assert.equal(pickedAt(set, picks), 1);
  });

  it("shows only the latest pick", () => {
    const picks = picksIn([reply, you("y1", pickText(set, 1)), claude("c2", "Sure."), you("y2", pickText(set, 2))]);
    assert.equal(pickedAt(set, picks), 2);
  });

  it("has no pick before Ben makes one, or for a message that isn't one", () => {
    assert.equal(pickedAt(set, picksIn([reply])), undefined);
    assert.equal(pickedAt(set, picksIn([reply, you("y1", "I like (b.png) best")])), undefined);
    assert.equal(pickedAt(set, undefined), undefined);
  });

  it("ignores a pick sent before the carousel was shown", () => {
    assert.equal(pickedAt(set, picksIn([you("y0", "Picked 1 of 3: Warm (a.png)"), reply])), undefined);
  });

  it("takes a typed pick by its number when it doesn't end with an address", () => {
    assert.equal(pickedAt(set, picksIn([reply, you("y1", "picked 3")])), 2);
    assert.equal(pickedAt(set, picksIn([reply, you("y1", "Picked 2 of 5")])), undefined);
  });

  it("keeps two carousels' picks apart, a pick going to the latest one with its image", () => {
    const again = claude("c2", "Variations on Cold:\n![Cold 1](b1.png)\n![Cold 2](b2.png)");
    const set2 = carouselsIn((again as { text: string }).text)[0];
    const picks = picksIn([reply, you("y1", pickText(set, 1)), again, you("y2", pickText(set2, 0))]);
    assert.equal(pickedAt(set, picks), 1);
    assert.equal(pickedAt(set2, picks), 0);
  });
});
