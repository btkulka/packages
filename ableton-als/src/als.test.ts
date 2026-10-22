import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import {
  AbletonFormatError,
  decodeAbletonXml,
  decodeXmlEntities,
  encodeAbletonXml,
  findMissingSamples,
  insertXmlComment,
  isGzip,
  isSplicePath,
  listFileRefs,
  readAbletonHeader,
  readAbletonXml,
  readAbletonXmlSync,
  sampleSearchKey,
  windowsPathFromData,
} from "./index.js";

// ---- fixtures: trimmed from real Live 12 and Live 10 sets ----

const fileRef11 = (relType: number, rel: string, path: string) => `
  <FileRef>
    <RelativePathType Value="${relType}" />
    <RelativePath Value="${rel}" />
    <Path Value="${path}" />
    <Type Value="1" />
    <LivePackName Value="" />
    <LivePackId Value="" />
    <OriginalFileSize Value="2822624" />
    <OriginalCrc Value="9892" />
  </FileRef>`;

const LIVE12 = `<?xml version="1.0" encoding="UTF-8"?>
<!-- a comment with <Fake Value="x"/> inside -->
<Ableton MajorVersion="5" MinorVersion="12.0_12203" SchemaChangeCount="3" Creator="Ableton Live 12.2.5" Revision="174fd107">
 <LiveSet>
  <Tracks>
   <AudioTrack Id="1">
    <Name><EffectiveName Value="Drums &amp; Perc" /><Annotation Value="a &gt; b > c" /></Name>
    <DeviceChain>
     <Devices>
      <PluginDevice Id="0">
       <PluginDesc>
        <VstPluginInfo Id="0">
         <Path Value="C:/Program Files/VSTPlugins/Serum_x64.dll" />
         <PlugName Value="Serum_x64" />
        </VstPluginInfo>
       </PluginDesc>
      </PluginDevice>
      <AudioEffectGroupDevice>
       <LastPresetRef>
        <Value>
         <FilePresetRef Id="0">${fileRef11(0, "", "C:/Users/x/Documents/Ableton/User Library/Presets/Bus.adg")}
         </FilePresetRef>
        </Value>
       </LastPresetRef>
      </AudioEffectGroupDevice>
     </Devices>
    </DeviceChain>
    <Events>
     <AudioClip Id="0" Time="0">
      <SampleRef>${fileRef11(3, "Samples/Imported/kick.wav", "B:/Old Drive/Song Project/Samples/Imported/kick.wav")}
       <LastModDate Value="1760493836" />
       <SourceContext>
        <SourceContext>
         <OriginalFileRef>${fileRef11(0, "", "C:/Users/x/Splice/Sounds/packs/Origin/kick.wav")}
         </OriginalFileRef>
        </SourceContext>
       </SourceContext>
      </SampleRef>
     </AudioClip>
     <AudioClip Id="1" Time="4">
      <SampleRef>${fileRef11(0, "", "C:/Users/x/Documents/Splice/Samples/packs/Herrero's Drum &amp; Bass/loop_&#39;b&#39;.wav")}
      </SampleRef>
     </AudioClip>
     <AudioClip Id="2" Time="8">
      <SampleRef>${fileRef11(0, "", "C:/Users/x/Documents/Splice/Samples/packs/Herrero's Drum &amp; Bass/loop_&#39;b&#39;.wav")}
      </SampleRef>
     </AudioClip>
     <AudioClip Id="3" Time="12">
      <SampleRef>${fileRef11(3, "Samples/Processed/Consolidate/Lev2_Kick_F#_06 [2024-08-23 203418].wav", "B:/Old Drive/Song Project/Samples/Processed/Consolidate/Lev2_Kick_F#_06 [2024-08-23 203418].wav")}
      </SampleRef>
     </AudioClip>
    </Events>
   </AudioTrack>
  </Tracks>
  <![CDATA[ <SampleRef><FileRef><Path Value="C:/cdata/is/ignored.wav"/></FileRef></SampleRef> ]]>
 </LiveSet>
</Ableton>
`;

function utf16Hex(s: string): string {
  const hex = Buffer.from(`${s}\0`, "utf16le").toString("hex").toUpperCase();
  return hex.replace(/(.{80})/g, "$1\n\t\t\t\t");
}

const LIVE10 = `<?xml version="1.0" encoding="UTF-8"?>
<Ableton MajorVersion="5" MinorVersion="10.0_377" SchemaChangeCount="1" Creator="Ableton Live 10.1.30" Revision="x">
 <LiveSet>
  <SampleRef>
   <FileRef>
    <HasRelativePath Value="true" />
    <RelativePathType Value="3" />
    <RelativePath>
     <RelativePathElement Id="1" Dir="Samples" />
     <RelativePathElement Id="2" Dir="Recorded" />
    </RelativePath>
    <Name Value="vox take.wav" />
    <Type Value="1" />
    <Data>
     ${utf16Hex("G:\\2016\\Song Project\\Samples\\Recorded\\vox take.wav")}
    </Data>
    <RefersToFolder Value="false" />
    <SearchHint><PathHint /><FileSize Value="0" /><Crc Value="0" /><MaxCrcSize Value="0" /><HasExtendedInfo Value="false" /></SearchHint>
    <LivePackName Value="" />
    <LivePackId Value="" />
   </FileRef>
  </SampleRef>
  <SampleRef>
   <FileRef>
    <HasRelativePath Value="true" />
    <RelativePathType Value="5" />
    <RelativePath>
     <RelativePathElement Id="4" Dir="Samples" />
     <RelativePathElement Id="5" Dir="Combined" />
    </RelativePath>
    <Name Value="Normal.aif" />
    <Type Value="2" />
    <Data>
     0000000001880002000008746D705F6461746100000000000000000000000000000000000000D10C
     E011482B000000EE2B3F0A4E6F726D616C2E616966000000000000000000000000000000000000
    </Data>
    <SearchHint>
     <PathHint>
      <RelativePathElement Id="8" Dir="trunk" />
      <RelativePathElement Id="9" Dir="Grand Piano" />
     </PathHint>
    </SearchHint>
    <LivePackName Value="Grand Piano" />
   </FileRef>
  </SampleRef>
  <FilePresetRef>
   <FileRef>
    <HasRelativePath Value="true" />
    <RelativePathType Value="1" />
    <RelativePath>
     <RelativePathElement Dir="" />
     <RelativePathElement Dir="" />
     <RelativePathElement Dir="Downloads" />
    </RelativePath>
    <Name Value="Reverb Default.adv" />
    <Data />
   </FileRef>
  </FilePresetRef>
 </LiveSet>
</Ableton>
`;

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "ableton-als-"));
}

// ---- envelope ----

test("encode/decode round-trips, and only gzip is accepted", () => {
  const gz = encodeAbletonXml(LIVE12);
  assert.equal(isGzip(gz), true);
  assert.equal(decodeAbletonXml(gz), LIVE12);
  assert.equal(isGzip(Buffer.from("<?xml")), false);
  assert.throws(() => decodeAbletonXml(Buffer.from("not gzip at all")), (e: unknown) => e instanceof AbletonFormatError && /Not a gzipped/.test((e as Error).message));
  assert.throws(() => decodeAbletonXml(Buffer.from([0x1f, 0x8b, 1, 2, 3, 4, 5])), (e: unknown) => e instanceof AbletonFormatError && /Corrupt gzip/.test((e as Error).message));
  assert.equal(decodeAbletonXml(gzipSync(Buffer.from("\uFEFF<Ableton/>", "utf8"))), "<Ableton/>");
});

test("readAbletonXml and readAbletonXmlSync read files, with Windows paths and spaces", async () => {
  const dir = tempDir();
  try {
    const p = join(dir, "My Song Project", "My Song.als");
    mkdirSync(join(dir, "My Song Project"));
    writeFileSync(p, encodeAbletonXml(LIVE10));
    assert.equal(readAbletonXmlSync(p), LIVE10);
    assert.equal(await readAbletonXml(p), LIVE10);
    const bad = join(dir, "bad.adg");
    writeFileSync(bad, "plain");
    await assert.rejects(readAbletonXml(bad), AbletonFormatError);
    assert.throws(() => readAbletonXmlSync(bad), AbletonFormatError);
    await assert.rejects(readAbletonXml(join(dir, "missing.als")), /ENOENT/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- header ----

test("readAbletonHeader reads versions and the document type", () => {
  assert.deepEqual(readAbletonHeader(LIVE12), {
    majorVersion: "5",
    minorVersion: "12.0_12203",
    schemaChangeCount: 3,
    creator: "Ableton Live 12.2.5",
    revision: "174fd107",
    liveVersion: "12.2.5",
    liveMajor: 12,
    documentType: "LiveSet",
  });
  const l10 = readAbletonHeader(LIVE10)!;
  assert.equal(l10.liveVersion, "10.1.30");
  assert.equal(l10.liveMajor, 10);
  assert.equal(readAbletonHeader('<Ableton Creator="Ableton Live 12.3b14"><LiveSet/></Ableton>')!.liveVersion, "12.3b14");
  assert.equal(readAbletonHeader('<Ableton MajorVersion="4" MinorVersion="9.0_305"><LiveSet/></Ableton>')!.liveMajor, 9);
});

test("a bare .adg preset (the extension store's fixture) has a header; other XML doesn't", () => {
  const h = readAbletonHeader('<?xml version="1.0"?><Ableton><GroupDevicePreset/></Ableton>')!;
  assert.equal(h.documentType, "GroupDevicePreset");
  assert.equal(h.creator, null);
  assert.equal(h.liveMajor, null);
  assert.equal(readAbletonHeader("<Ableton/>")!.documentType, null);
  assert.equal(readAbletonHeader("<Ableton></Ableton>")!.documentType, null);
  assert.equal(readAbletonHeader('<?xml version="1.0"?><svg><g/></svg>'), null);
  assert.equal(readAbletonHeader("just text"), null);
  assert.equal(readAbletonHeader(""), null);
});

// ---- file references ----

test("Live 11/12 references: decoded paths, owners, relative paths; plugin binaries and CDATA are not references", () => {
  const refs = listFileRefs(LIVE12);
  assert.deepEqual(
    refs.map((r) => [r.owner, r.relativeTo, r.name]),
    [
      ["FilePresetRef", "none", "Bus.adg"],
      ["SampleRef", "project", "kick.wav"],
      ["OriginalFileRef", "none", "kick.wav"],
      ["SampleRef", "none", "loop_'b'.wav"],
      ["SampleRef", "none", "loop_'b'.wav"],
      ["SampleRef", "project", "Lev2_Kick_F#_06 [2024-08-23 203418].wav"],
    ],
  );
  assert.equal(refs[1]!.path, "B:/Old Drive/Song Project/Samples/Imported/kick.wav");
  assert.equal(refs[1]!.relativePath, "Samples/Imported/kick.wav");
  assert.equal(refs[3]!.path, "C:/Users/x/Documents/Splice/Samples/packs/Herrero's Drum & Bass/loop_'b'.wav");
  assert.equal(refs[3]!.relativePath, "");
  assert.ok(!refs.some((r) => r.path?.endsWith(".dll")));
  assert.ok(!refs.some((r) => r.path?.includes("cdata")));
});

test("Live 9/10 references: Windows <Data> paths, element-list relative paths, '..' and macOS aliases", () => {
  const refs = listFileRefs(LIVE10);
  assert.equal(refs.length, 3);
  assert.deepEqual(refs[0], {
    path: "G:\\2016\\Song Project\\Samples\\Recorded\\vox take.wav",
    relativePath: "Samples/Recorded/vox take.wav",
    relativeTo: "project",
    name: "vox take.wav",
    owner: "SampleRef",
  });
  assert.deepEqual(refs[1], { path: null, relativePath: "Samples/Combined/Normal.aif", relativeTo: "library", name: "Normal.aif", owner: "SampleRef" });
  assert.deepEqual(refs[2], { path: null, relativePath: "../../Downloads/Reverb Default.adv", relativeTo: "external", name: "Reverb Default.adv", owner: "FilePresetRef" });
});

test("empty references are skipped", () => {
  assert.deepEqual(listFileRefs('<Ableton><SampleRef><FileRef><RelativePathType Value="0"/><RelativePath Value=""/><Path Value=""/></FileRef></SampleRef></Ableton>'), []);
});

test("windowsPathFromData decodes drive and UNC paths and refuses anything else", () => {
  assert.equal(windowsPathFromData(utf16Hex("C:\\a\\b.wav")), "C:\\a\\b.wav");
  assert.equal(windowsPathFromData(utf16Hex("\\\\nas\\share\\x.wav")), "\\\\nas\\share\\x.wav");
  assert.equal(windowsPathFromData(utf16Hex("/Users/x/a.wav")), null);
  assert.equal(windowsPathFromData("ABC"), null);
  assert.equal(windowsPathFromData("ZZZZ"), null);
  assert.equal(windowsPathFromData(""), null);
});

// ---- missing samples ----

test("findMissingSamples: project-relative resolution, decoding, dedupe, Splice flags, search keys", () => {
  const dir = tempDir();
  try {
    // The project moved from B:/Old Drive to here; Live finds kick.wav by its relative path.
    mkdirSync(join(dir, "Samples", "Imported"), { recursive: true });
    writeFileSync(join(dir, "Samples", "Imported", "kick.wav"), "RIFF");
    const als = join(dir, "Song.als");
    writeFileSync(als, encodeAbletonXml(LIVE12));
    const r = findMissingSamples(als);
    assert.equal(r.alsPath, als);
    assert.equal(r.totalRefs, 3); // kick, loop (twice -> once), consolidated
    assert.equal(r.spliceRefs, 1);
    assert.equal(r.unresolved, 0);
    assert.deepEqual(r.missing, [
      {
        originalPath: "C:/Users/x/Documents/Splice/Samples/packs/Herrero's Drum & Bass/loop_'b'.wav",
        relativePath: "",
        basename: "loop_'b'.wav",
        searchKey: "loop_'b'",
        isSplice: true,
      },
      {
        originalPath: "B:/Old Drive/Song Project/Samples/Processed/Consolidate/Lev2_Kick_F#_06 [2024-08-23 203418].wav",
        relativePath: "Samples/Processed/Consolidate/Lev2_Kick_F#_06 [2024-08-23 203418].wav",
        basename: "Lev2_Kick_F#_06 [2024-08-23 203418].wav",
        searchKey: "Lev2_Kick_F#_06",
        isSplice: false,
      },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findMissingSamples takes xml, an exists check and a project folder; mac aliases are unresolved", () => {
  const checked: string[] = [];
  const r = findMissingSamples("D:/Music/Song Project/Song.als", {
    xml: LIVE10,
    projectDir: "D:/Elsewhere",
    exists: (p) => {
      checked.push(p);
      return false;
    },
  });
  assert.equal(r.totalRefs, 1);
  assert.equal(r.unresolved, 1);
  assert.equal(r.missing.length, 1);
  assert.equal(r.missing[0]!.originalPath, "G:\\2016\\Song Project\\Samples\\Recorded\\vox take.wav");
  assert.equal(r.missing[0]!.searchKey, "vox take");
  assert.equal(checked.length, 2); // relative first, then absolute
  assert.match(checked[0]!.replace(/\\/g, "/"), /Elsewhere\/Samples\/Recorded\/vox take\.wav$/);
});

test("isSplicePath and sampleSearchKey", () => {
  assert.equal(isSplicePath("C:\\Users\\x\\Splice\\Sounds\\packs\\p\\a.wav"), true);
  assert.equal(isSplicePath("/Users/x/Splice/Sounds/packs/p/a.wav"), true);
  assert.equal(isSplicePath("C:/Users/x/Documents/Splice - alt-account/Samples/packs/a.wav"), true);
  assert.equal(isSplicePath("C:/Users/x/Splicer/a.wav"), false);
  assert.equal(isSplicePath("C:/Users/x/MySplice/a.wav"), false);
  assert.equal(isSplicePath(null), false);
  assert.equal(sampleSearchKey("Lev2_Kick_F#_06 [2024-08-23 203418].wav"), "Lev2_Kick_F#_06");
  assert.equal(sampleSearchKey("C:\\x\\y\\snare.v2.aif"), "snare.v2");
  assert.equal(sampleSearchKey(".hidden"), ".hidden");
  assert.equal(sampleSearchKey("INDIGO [2025-10-23 042514] (Vocals).wav"), "INDIGO [2025-10-23 042514] (Vocals)");
});

// ---- watermark comment ----

test("insertXmlComment goes after the declaration and keeps the document valid", () => {
  const xml = '<?xml version="1.0"?><Ableton><GroupDevicePreset/></Ableton>';
  const stamped = insertXmlComment(xml, "ALX license ALX-AB12-CD34 · buyer #7");
  assert.equal(stamped, '<?xml version="1.0"?>\n<!-- ALX license ALX-AB12-CD34 · buyer #7 -->' + "<Ableton><GroupDevicePreset/></Ableton>");
  assert.equal(readAbletonHeader(stamped)!.documentType, "GroupDevicePreset");
  assert.equal(decodeAbletonXml(encodeAbletonXml(stamped)), stamped);

  assert.equal(insertXmlComment("<Ableton/>", "x"), "<!-- x -->\n<Ableton/>");
  const tricky = insertXmlComment("<Ableton/>", "a--b--->c-");
  assert.ok(!/--(?!>)/.test(tricky.slice(4, tricky.indexOf("-->"))), tricky);
  assert.equal(readAbletonHeader(tricky)!.documentType, null);
});

// ---- scanner details ----

test("entities: named, decimal, hex; unknown ones are left alone", () => {
  assert.equal(decodeXmlEntities("a &amp; b &lt;c&gt; &quot;q&quot; &apos;s&apos; &#39; &#x0A; &#X41; &nbsp; &bogus"), "a & b <c> \"q\" 's' ' \n A &nbsp; &bogus");
  assert.equal(decodeXmlEntities("plain"), "plain");
});

test("attribute parsing honours quotes", () => {
  const xml = `<Ableton><SampleRef><FileRef><Path Note=" Value='decoy'" Value="C:/real.wav" /></FileRef></SampleRef><X Value='single "quoted"' /></Ableton>`;
  assert.equal(listFileRefs(xml)[0]!.path, "C:/real.wav");
});
