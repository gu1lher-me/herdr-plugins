// Claude Code and Codex plan usage at the foot of the sidebar: one bar per limit window.
// Reads shared "cc.usage" (cc-status fetches it); a click asks for fresh numbers.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { shared, setShared, theme, run } from "herdr";

const AGENTS = [{ key: "claude", name: "Claude" }, { key: "codex", name: "Codex" }];
// PAD: py(10) twice plus room for the last row's descenders, which 20 clipped.
const ROW = 44, HEAD = 22, PAD = 26, GAP = 8;

// "resets in 25m", "resets at 14:20" (today), "resets on Mon 02:29" (another day).
function resets(at) {
  if (!at) return "";
  const m = Math.round((at - Date.now()) / 60_000);
  if (m <= 0) return "resetting now";
  if (m < 60) return `resets in ${m}m`;
  const d = new Date(at), time = d.toTimeString().slice(0, 5);
  if (d.toDateString() === new Date().toDateString()) return `resets at ${time}`;
  return `resets on ${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()]} ${time}`;
}

export default class Usage extends View {
  init(_props, cx) {
    this.height = 0;
    cx.timer.every(60_000, (cx) => cx.notify());
  }

  render(cx) {
    const t = theme();
    const data = shared("cc.usage") ?? {};
    const shown = AGENTS.filter((a) => data[a.key]?.windows?.length || data[a.key]?.error);

    // The block fits its rows: grow or shrink it when an agent's limits appear or go.
    const height = shown.length ? PAD + GAP * (shown.length - 1) + shown.reduce((h, a) => h + HEAD + (data[a.key].windows?.length ?? 0) * ROW, 0) : 0;
    if (height !== this.height) {
      this.height = height;
      cx.spawn(async () => { run("layout.resize", { id: "usage", px: Math.max(height, 1) }); });
    }

    // Name and percentage (what you glance at), the bar, then when it frees up, or for extra-usage credits what's
    // spent of the limit (detail; alert when the limit is reached).
    const bar = (w, key) => {
      const color = w.alert || w.used >= 90 ? t.blocked : w.used >= 70 ? t.working : t.muted;
      const pct = w.used > 0 && w.used < 1 ? "<1%" : `${Math.round(w.used)}%`;
      const below = w.detail || (w.resetsAt ? resets(w.resetsAt) : "");
      return v_flex().id(key).h(ROW).justify_center().gap(4)
        .child(h_flex().justify_between().text_size(11.5)
          .child(div().text_color(t.muted).child(w.label))
          .child(div().font_medium().text_color(w.alert || w.used >= 70 ? color : t.foreground).child(pct)))
        .child(div().h(5).w_full().rounded(3).bg(t.raised)
          .child(div().h(5).rounded(3).bg(color).w(`${Math.max(2, w.used)}%`)))
        .when(Boolean(below), (el) => el.child(div().text_size(10.5).text_color(w.alert ? t.blocked : t.dim).truncate().child(below)));
    };

    return v_flex().id("cc-usage").size_full().px(14).py(10).gap(GAP).bg(t.chrome).border_t(1).border_color(t.border)
      .on_click(() => setShared("cc.usage.request", Date.now()))
      .children(shown.map((a) => v_flex()
        .child(h_flex().h(HEAD).items_center().gap(6).text_size(11.5)
          .child(div().font_medium().text_color(t.foreground).child(a.name))
          .when(Boolean(data[a.key].error), (el) => el.child(div().flex_1().min_w(0).truncate().text_size(10.5).text_color(t.blocked).child(data[a.key].error))))
        .children((data[a.key].windows ?? []).map((w, n) => bar(w, `${a.key}-${n}`)))));
  }
}
