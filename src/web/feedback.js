/**
 * 反馈抽屉：用户看什么、发什么，自己说了算。
 *
 * 三个刻意的选择：
 *  1. **先预览后提交**：要发出去的文本原样显示在框里，用户能一条条看；
 *  2. **默认不带成绩**：成绩是用户的数据，要单独勾选；
 *  3. **发不出去也不丢**：落本机 JSONL，并给"导出反馈包"，用户可以直接发给开发者。
 */
const $ = (sel, root = document) => root.querySelector(sel);

let state = null;

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

export function openFeedback({ api, rel, resultId = null, context = "", onToast = () => {} }) {
  state = { api, rel, resultId, context, preview: "", loading: false, sending: false, sent: null, bytes: 0, logLines: 0, attach: false };

  const backdrop = document.createElement("div");
  backdrop.className = "fb-backdrop";
  backdrop.innerHTML = `
    <div class="fb-drawer" role="dialog" aria-modal="true" aria-labelledby="fb-title">
      <div class="fb-head">
        <h2 id="fb-title">反馈问题</h2>
        <button class="icon-btn" data-fb="close" aria-label="关闭">✕</button>
      </div>
      <div class="fb-body">
        <p class="fb-lead">卡住了、算错了、看不懂 —— 都欢迎。我会带上环境信息和最近的错误日志，<b>发之前你可以先看一遍</b>。</p>

        <label class="fb-label" for="fb-message">发生了什么</label>
        <textarea id="fb-message" rows="4" placeholder="比如：点开始体检后页面白屏，重启应用也一样"></textarea>

        <label class="fb-label" for="fb-contact">联系方式（可选）</label>
        <input id="fb-contact" type="text" placeholder="邮箱 / 微信 / 论坛 ID，方便我追问细节" />

        <label class="check fb-attach">
          <input type="checkbox" id="fb-attach" />
          附带最近一次成绩（指标与耗时，不含目录路径）
        </label>

        <div class="fb-preview-head">
          <span>将要发送的内容</span>
          <span class="spacer"></span>
          <span class="faint" id="fb-stats">填写描述后自动生成</span>
        </div>
        <pre class="fb-preview" id="fb-preview">（填写描述后，这里会显示完整的反馈文本）</pre>
        <div class="fb-note">
          已自动隐藏：内网/公网 IP、主机名、你的目录结构、任何令牌。日志只带错误、告警和关键事件，不带逐次请求记录。
        </div>
      </div>
      <div class="fb-foot">
        <button class="btn ghost" data-fb="export">导出反馈包</button>
        <span class="fb-hint"></span>
        <span class="spacer"></span>
        <button class="btn ghost" data-fb="refresh">刷新预览</button>
        <button class="btn primary" data-fb="send">发送反馈</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);
  document.body.style.overflow = "hidden";

  const el = (name) => $(`[data-fb="${name}"]`, backdrop);
  const message = $("#fb-message", backdrop);
  const contact = $("#fb-contact", backdrop);
  const attach = $("#fb-attach", backdrop);
  const preview = $("#fb-preview", backdrop);
  const stats = $("#fb-stats", backdrop);

  let timer = null;
  const schedulePreview = () => {
    clearTimeout(timer);
    timer = setTimeout(refreshPreview, 500);
  };

  async function refreshPreview() {
    const msg = message.value.trim();
    if (msg.length < 4) {
      preview.textContent = "（填写描述后，这里会显示完整的反馈文本）";
      stats.textContent = "填写描述后自动生成";
      state.preview = "";
      return;
    }
    state.loading = true;
    stats.textContent = "生成中…";
    try {
      const q = new URLSearchParams({ message: msg, contact: contact.value.trim(), context: state.context });
      if (state.resultId && attach.checked) {
        q.set("resultId", state.resultId);
        q.set("attachResult", "1");
      }
      const out = await state.api(`/api/feedback/preview?${q.toString()}`);
      state.preview = out.report;
      state.bytes = out.bytes;
      state.logLines = out.logLines;
      preview.textContent = out.report;
      stats.textContent = `${(out.bytes / 1024).toFixed(1)} KB · ${out.logLines} 行日志`;
    } catch (e) {
      stats.textContent = "预览失败：" + e.message;
    } finally {
      state.loading = false;
    }
  }

  message.addEventListener("input", schedulePreview);
  contact.addEventListener("input", schedulePreview);
  attach.addEventListener("change", () => {
    state.attach = attach.checked;
    refreshPreview();
  });

  backdrop.addEventListener("click", async (ev) => {
    if (ev.target === backdrop) return close();
    const btn = ev.target.closest("[data-fb]");
    if (!btn) return;
    const action = btn.dataset.fb;

    if (action === "close") return close();
    if (action === "refresh") return refreshPreview();

    if (action === "export") {
      const text = state.preview || preview.textContent;
      const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `niudao-feedback-${new Date().toISOString().slice(0, 10)}.txt`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      onToast("反馈包已导出，可以自己发给我", "ok");
      return;
    }

    if (action === "send") {
      const msg = message.value.trim();
      if (msg.length < 4) return onToast("先写一句发生了什么，至少四个字", "err");
      state.sending = true;
      btn.disabled = true;
      btn.textContent = "发送中…";
      const hint = $(".fb-foot .fb-hint", backdrop);
      if (hint) hint.textContent = "正在发送，可能需要几秒（网络不好时会重试）…";
      try {
        const out = await state.api("/api/feedback", {
          method: "POST",
          body: JSON.stringify({
            message: msg,
            contact: contact.value.trim(),
            context: state.context,
            resultId: state.resultId,
            attachResult: attach.checked,
          }),
        });
        state.sent = out;
        // 关键：先让用户在这块地方看到结果，再关抽屉。
        // 之前只弹 toast，而 toast 被抽屉的 z-index 盖住 → 用户以为"点了没反应"。
        if (!out.sent) {
          if (hint) hint.textContent = out.message || "没发出去，已保存在本机";
          btn.disabled = false;
          btn.textContent = "重试发送";
          onToast(out.message || "已保存到本机", "err");
          return;
        }
        // 留在抽屉里显示结果：用户点"完成"才关。
        // （之前自动关 + toast 被抽屉遮住 = "点了没反应"）
        preview.textContent = `✅ 已发送（${(out.bytes / 1024).toFixed(1)} KB）\n编号 ${out.id}\n\n我会在后台看到这条反馈和脱敏日志，谢谢！`;
        if (hint) hint.textContent = "已发送";
        btn.textContent = "完成";
        btn.disabled = false;
        btn.dataset.fb = "close";
        message.disabled = true;
        contact.disabled = true;
        attach.disabled = true;
        const retry = $('[data-fb="refresh"]', backdrop);
        if (retry) retry.style.display = "none";
        onToast("已发送，谢谢！", "ok");
      } catch (e) {
        onToast("发送失败：" + e.message, "err");
      } finally {
        state.sending = false;
        btn.disabled = false;
        btn.textContent = "发送反馈";
      }
    }
  });

  const onKey = (ev) => {
    if (ev.key === "Escape") close();
  };
  document.addEventListener("keydown", onKey);

  function close() {
    document.removeEventListener("keydown", onKey);
    backdrop.remove();
    document.body.style.overflow = "";
    state = null;
  }

  message.focus();
  return { close };
}

export function openFeedbackWithContext(ctx) {
  return openFeedback(ctx);
}
