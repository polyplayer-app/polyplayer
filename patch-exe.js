// Ставит значок PolyPlayer и сведения о версии в PolyPlayer.exe (вместо значка Electron).
// node patch-exe.js <exe> <ico> <version>
const ResEdit = require('resedit');
const fs = require('fs');
const [exePath, icoPath, version] = process.argv.slice(2);
const v = version.split('.').map((x) => parseInt(x, 10) || 0).concat([0, 0, 0, 0]).slice(0, 4);
const ico = ResEdit.Data.IconFile.from(fs.readFileSync(icoPath));
const exe = ResEdit.NtExecutable.from(fs.readFileSync(exePath), { ignoreCert: true });
const res = ResEdit.NtExecutableResource.from(exe);
const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
const gid = groups.length ? groups[0].id : 1;
const lang = groups.length ? groups[0].lang : 1033;
ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, gid, lang, ico.icons.map((i) => i.data));
const vi = ResEdit.Resource.VersionInfo.fromEntries(res.entries)[0];
vi.setFileVersion(...v, 1033); vi.setProductVersion(...v, 1033);
vi.setStringValues({ lang: 1033, codepage: 1200 }, {
  FileDescription: 'PolyPlayer', ProductName: 'PolyPlayer', CompanyName: 'PolyPlayer',
  InternalName: 'PolyPlayer', OriginalFilename: 'PolyPlayer.exe', LegalCopyright: 'PolyPlayer',
  FileVersion: version, ProductVersion: version
});
vi.outputToResourceEntries(res.entries);
res.outputResource(exe);
fs.writeFileSync(exePath, Buffer.from(exe.generate()));
console.log('patched', exePath, version, 'icons:', ico.icons.length);
