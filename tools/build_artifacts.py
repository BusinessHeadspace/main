"""Build the claude.ai artifact pages from index.html.

    python3 tools/build_artifacts.py

Writes two files to dist/ (not committed):
  dist/client.html      Client edition: the calculator with Xero report import,
                        opening on sample data.
  dist/my-numbers.html  Private edition: the calculator plus the live Xero add-on
                        in editions/my-numbers/xero-live.js. Publish it with the
                        mcp (Xero), db and user capabilities.

The artifact viewer supplies its own <head>, blocks print dialogs, pop-up
confirmations and downloads, so those parts of index.html are adapted here.
"""
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"


def rep(s, old, new, count=1):
    found = s.count(old)
    if found != count:
        raise SystemExit(f"build_artifacts: expected {count} match(es), found {found}: {old[:70]!r}")
    return s.replace(old, new)


def base(src, title):
    s = src
    s = rep(s, '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="UTF-8">\n'
               '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
               '<title>Pricing &amp; Profit Calculator</title>',
            f'<title>{title}</title>\n<meta name="claude:viewport-fit-sides" content="cover">')
    s = rep(s, '</head>\n<body>\n', '')
    s = rep(s, '</body>\n</html>\n', '')
    s = rep(s, '.wrap { max-width: 1280px; margin: 0 auto; padding: 24px 16px 48px; }',
            '.wrap { max-width: 1280px; margin: 0 auto; padding-block: 24px 48px; '
            'padding-left: max(16px, env(safe-area-inset-left, 0px)); '
            'padding-right: max(16px, env(safe-area-inset-right, 0px)); }')
    # No print dialog or downloads in the viewer
    s = rep(s, '\n      <button class="btn btn-gold" id="printBtn" type="button">Print / Save as PDF</button>', '')
    s = rep(s, '  $("printBtn").addEventListener("click", () => window.print());\n', '')
    s = rep(s, '\n      <button class="btn btn-outline" id="saveBtn" type="button">Save to file</button>', '')
    s, n = re.subn(r'  \$\("saveBtn"\)\.addEventListener\("click".*?showFileMsg\("Saved " \+ a\.download \+ " to your downloads\."\);\n  \}\);\n',
                   '', s, flags=re.S)
    if n != 1:
        raise SystemExit("build_artifacts: save handler not found")
    # confirm() is blocked in the viewer: confirm by clicking twice instead
    s = rep(s, '''  $("sampleBtn").addEventListener("click", () => {
    if (state.clients.length && !confirm("Replace your current clients and targets with the sample data?")) return;''',
            '''  function confirmClick(btn, prompt) {
    if (btn.dataset.armed) {
      clearTimeout(+btn.dataset.armed);
      delete btn.dataset.armed;
      btn.textContent = btn.dataset.label;
      return true;
    }
    btn.dataset.label = btn.textContent;
    btn.textContent = prompt;
    btn.dataset.armed = setTimeout(() => { delete btn.dataset.armed; btn.textContent = btn.dataset.label; }, 4000);
    return false;
  }

  $("sampleBtn").addEventListener("click", () => {
    if (state.clients.length && !confirmClick($("sampleBtn"), "Click again to replace")) return;''')
    s = rep(s, '''    if (!confirm("Clear all clients and targets? This can't be undone.")) return;''',
            '''    if (!confirmClick($("clearBtn"), "Click again to clear")) return;''')
    return s


def client(src):
    s = base(src, "Pricing &amp; Profit Calculator")
    s = rep(s, "<p>Work out the revenue you need, then check which clients are getting you there.</p>",
            "<p>Work out the revenue you need, then check which clients are getting you there.</p>\n"
            '      <p id="sampleNote" style="font-size:.85rem;">It opens with 10 made-up sample clients so you can try it out. '
            "Click <strong>Import from Xero</strong> to bring in your own figures, or <strong>Clear all</strong> to start from scratch.</p>")
    s = rep(s, '''    delete state.desiredIncome;
  }''', '''    delete state.desiredIncome;
  } else {
    state = JSON.parse(JSON.stringify(SAMPLE));
  }''')
    return s


def my_numbers(src):
    s = base(src, "My Pricing &amp; Profit")
    s = rep(s, "<h1>Pricing &amp; Profit Calculator</h1>", "<h1>My Pricing &amp; Profit</h1>")
    s = rep(s, "<p>Work out the revenue you need, then check which clients are getting you there.</p>",
            "<p>Your own numbers, live from Xero. Add hours for each client to see your real hourly rates.</p>")
    # Live Xero replaces the report import and the sample data
    s = rep(s, '\n      <button class="btn btn-teal" id="importBtn" type="button">Import from Xero</button>', '')
    s = rep(s, '  $("importBtn").addEventListener("click", openImport);\n', '')
    s = rep(s, '\n      <button class="btn btn-outline" id="sampleBtn" type="button">Load sample data</button>', '')
    s, n = re.subn(r'  \$\("sampleBtn"\)\.addEventListener\("click", \(\) => \{.*?renderAll\(\);\n  \}\);\n', '', s, flags=re.S)
    if n != 1:
        raise SystemExit("build_artifacts: sample handler not found")
    addon = (ROOT / "editions/my-numbers/xero-live.js").read_text()
    return s + "<script>\n" + addon + "</script>\n"


def main():
    src = (ROOT / "index.html").read_text()
    DIST.mkdir(exist_ok=True)
    (DIST / "client.html").write_text(client(src))
    (DIST / "my-numbers.html").write_text(my_numbers(src))
    print("Wrote dist/client.html and dist/my-numbers.html")


if __name__ == "__main__":
    main()
