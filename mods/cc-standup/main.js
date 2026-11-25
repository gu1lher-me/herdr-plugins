// The standup draft as a pane: edit a bullet (click it), drop it (×), reorder (press one, release on another),
// ask Claude to change one bullet (✦) or the whole draft (the box below), Undo, Write now, Copy.
// cc-status owns the draft; every change goes to it as shared "cc.standup.action".

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { shared, setShared, theme, exec } from "herdr";

const act = (a) => setShared("cc.standup.action", { ...a, at: Date.now() });
const copyText = (text) => exec("sh", ["-c", 'printf %s "$1" | pbcopy', "sh", text]);
const clock = (ms) => new Date(ms).toTimeString().slice(0, 5);
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

export default class Standup extends View {
  init(_props, cx) {
    this.editing = null;   // a bullet id, or "new"
    this.pressed = null;   // bullet id being dragged
    this.over = null;
    this.askFor = null;    // a bullet id, or null for the whole draft
    this.copied = false;
    this.edit = InputState.new({});
    this.edit.on("submit", (_e, cx) => this.saveEdit(cx));
    this.edit.on("blur", (_e, cx) => this.saveEdit(cx));
    this.ask = InputState.new({ placeholder: "Ask Claude to change the draft: shorter, merge the CRM bullets, add…" });
    this.ask.on("submit", (_e, cx) => {
      const instruction = this.ask.value().trim();
      if (!instruction) return;
      act({ op: "ask", instruction, id: this.askFor });
      this.ask.set_value("");
      this.askFor = null;
      cx.notify();
    });
    this.handle = cx.focus_handle();
  }

  startEdit(id, text, cx) {
    this.editing = id;
    this.edit.set_value(text);
    this.edit.focus();
    cx.notify();
  }

  saveEdit(cx) {
    if (!this.editing) return;
    const text = this.edit.value();
    const b = (shared("cc.standup")?.bullets ?? []).find((x) => x.id === this.editing);
    if (this.editing === "new") { if (text.trim()) act({ op: "add", text }); }
    else if (b && text !== b.text) act({ op: "set", id: this.editing, text });
    this.editing = null;
    cx.notify();
  }

  render() {
    const t = theme();
    const s = shared("cc.standup") ?? {};
    const bullets = s.bullets ?? [];
    const stop = (_e, cx) => cx.stop_propagation();
    const busy = s.running || Boolean(s.asking);

    const button = (id, label, primary, action, enabled = true) => div().id(id).flex_none().px(10).py(4).rounded(6).text_size(12).font_medium().border_1()
      .border_color(primary ? t.solid : t.border).bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground)
      .opacity(enabled ? 1 : 0.45).hover((st) => st.opacity(enabled ? 0.85 : 0.45)).on_mouse_down("left", stop)
      .on_click((_e, cx) => { if (enabled) { action(cx); cx.notify(); } }).child(label);
    const icon = (id, glyph, color, action) => div().id(id).flex_none().w(22).h(22).rounded(5).text_center().text_size(13).text_color(color)
      .hover((st) => st.bg(t.hover)).on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); action(cx); cx.notify(); }).child(glyph);

    const row = (b, n) => {
      const editing = this.editing === b.id, dragging = this.pressed === b.id;
      const target = this.pressed && this.over === b.id && this.pressed !== b.id;
      const asking = s.asking === b.id;
      return h_flex().id(`b-${b.id}`).w_full().px(10).py(7).gap(8).items_start().rounded(7)
        .border_1().border_color(target ? t.accent : this.askFor === b.id ? t.accent : t.background)
        .bg(dragging ? t.selected : t.background).hover((st) => st.bg(t.hover)).opacity(asking ? 0.5 : 1)
        .on_hover((hovered, cx) => { if (hovered && this.pressed) { this.over = b.id; cx.notify(); } })
        .on_mouse_down("left", (_e, cx) => { if (!editing) { this.pressed = b.id; this.over = b.id; cx.notify(); } })
        .on_mouse_up("left", (_e, cx) => {
          const from = this.pressed;
          this.pressed = null; this.over = null;
          // Released where it was pressed: a click, so edit it. Elsewhere: move it there.
          if (from === b.id) this.startEdit(b.id, b.text, cx);
          else if (from) act({ op: "move", id: from, to: b.id });
          cx.notify();
        })
        .child(div().flex_none().w(14).mt(1).text_size(12).text_color(t.dim).child("⋮⋮"))
        .child(div().flex_none().w(16).mt(1).text_size(12).text_color(t.dim).child(`${n + 1}.`))
        .child(editing
          ? Input.new(this.edit).flex_1().h(28).px(8).rounded(6).border_1().border_color(t.accent).bg(t.background).text_size(13)
          : div().flex_1().min_w(0).text_size(13).line_height(1.45).child(b.text))
        .when(!editing && !busy, (el) => el
          .child(icon(`ask-${b.id}`, "✦", this.askFor === b.id ? t.accent : t.dim, () => { this.askFor = this.askFor === b.id ? null : b.id; this.ask.focus(); }))
          .child(icon(`rm-${b.id}`, "×", t.dim, () => act({ op: "remove", id: b.id }))));
    };

    const n = s.sources;
    const sub = s.running ? "Writing a new draft…" : s.error ? `Couldn't write it: ${s.error}`
      : s.at ? `${s.date} · written ${clock(s.at)}${s.edited ? " · edited" : ""}${n ? ` · from ${plural(n.commits, "commit")}, ${plural(n.prs, "PR")}, ${plural(n.tasks, "task note")}, ${plural(n.asks ?? 0, "Slack ask")}, Jira and Slack` : ""}`
      : "No draft yet";
    const askTarget = this.askFor && bullets.findIndex((b) => b.id === this.askFor);

    return v_flex().id("cc-standup").track_focus(this.handle).size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .on_mouse_up("left", (_e, cx) => { if (this.pressed) { this.pressed = null; this.over = null; cx.notify(); } })
      .child(v_flex().flex_none().px(14).pt(12).pb(10).gap(4).border_b(1).border_color(t.border)
        .child(h_flex().gap(8).items_center()
          .child(div().font_semibold().text_size(14).child(`What did you accomplish?${s.label ? ` · ${s.label}` : ""}`))
          .child(div().flex_1())
          .child(button("su-undo", "Undo", false, () => act({ op: "undo" }), Boolean(s.canUndo) && !busy))
          .child(button("su-write", "Write now", false, () => setShared("cc.standup.request", Date.now()), !busy))
          .child(button("su-copy", this.copied ? "Copied" : "Copy", true, () => { copyText(s.text ?? ""); this.copied = true; }, bullets.length > 0)))
        .child(div().text_size(11.5).text_color(s.error ? t.blocked : t.dim).child(sub)))
      .child(v_flex().id("cc-standup-list").flex_1().min_h(0).overflow_y_scrollbar().p(8).gap(2)
        .children(bullets.map(row))
        .child(this.editing === "new"
          ? h_flex().px(10).py(5).gap(8).child(div().w(38)).child(Input.new(this.edit).flex_1().h(28).px(8).rounded(6).border_1().border_color(t.accent).bg(t.background).text_size(13))
          : div().id("su-add").px(10).py(6).ml(38).text_size(12.5).text_color(t.dim).hover((st) => st.text_color(t.foreground))
            .on_click((_e, cx) => this.startEdit("new", "", cx)).child("+ Add a bullet")))
      .child(v_flex().flex_none().px(14).py(10).gap(6).border_t(1).border_color(t.border).bg(t.chrome)
        .child(h_flex().gap(8).items_center().text_size(11.5).text_color(s.askError ? t.blocked : t.dim)
          .child(div().flex_1().min_w(0).truncate().child(
            s.asking ? `Claude is changing ${s.asking === "all" ? "the draft" : "a bullet"}…`
              : s.askError ? `Couldn't change it: ${s.askError}`
              : askTarget >= 0 && askTarget !== null ? `Change bullet ${askTarget + 1}` : "Change the whole draft"))
          .when(askTarget >= 0 && askTarget !== null, (el) => el.child(div().id("ask-all").text_color(t.muted).hover((st) => st.text_color(t.foreground))
            .on_click((_e, cx) => { this.askFor = null; cx.notify(); }).child("whole draft instead"))))
        .child(Input.new(this.ask).h(32).px(10).rounded(7).border_1().border_color(this.askFor ? t.accent : t.input).bg(t.background).text_size(12.5)));
  }
}
