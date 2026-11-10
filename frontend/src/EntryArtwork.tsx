import { useEffect, useRef } from "react";
import { CalendarDays, Check, ClipboardCheck, Dices } from "lucide-react";

export default function EntryArtwork() {
  const art = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = art.current;
    if (!element) return;
    if (typeof CSS === "undefined" || !CSS.registerProperty) return;
    // The original angles, offsets and CSS easing are unchanged. Interpolating
    // typed paint properties rerasterizes lettering at each angle instead of
    // rotating a cached, antialiased text bitmap on the compositor.
    const properties = [
      ["--entry-paper-angle", "<angle>", "-8deg"],
      ["--entry-paper-lift", "<length>", "0px"],
      ["--entry-ticket-angle", "<angle>", "6deg"],
      ["--entry-ticket-x", "<length>", "0px"],
      ["--entry-ticket-y", "<length>", "0px"],
    ];
    for (const [name, syntax, initialValue] of properties) {
      try {
        CSS.registerProperty({ name, syntax, initialValue, inherits: false });
      } catch (error) {
        // Login/logout can mount the artwork again in the same document.
        if (!(
          error instanceof DOMException &&
          error.name === "InvalidModificationError"
        ))
          return;
      }
    }
    element.classList.add("entry-art--painted-motion");
    return () => {
      element.classList.remove("entry-art--painted-motion");
    };
  }, []);
  return (
    <div ref={art} className="entry-art" aria-hidden="true">
      <div className="art-grid" />
      <div className="art-backdrop">
        DEMO<span>我们的班级事务簿</span>
      </div>
      <div className="art-paper">
        <span className="art-clip" />
        <ClipboardCheck size={28} />
        <strong>
          <span className="art-paper-lead">每一份，</span>都收好了。
        </strong>
        <p>选择文件 · 上传 · 确认提交</p>
        <div className="art-file">
          <span>IMG</span>
          <div>
            <b>活动任务截图</b>
            <i />
          </div>
          <Check size={17} />
        </div>
        <div className="art-file">
          <span>DOC</span>
          <div>
            <b>任务附件</b>
            <i />
          </div>
          <Check size={17} />
        </div>
        <small>每一份提交，都有记录</small>
      </div>
      <div className="art-ticket">
        <Dices size={26} />
        <div>
          <b>下一个，会是谁？</b>
          <span>活动抽签 · 规则公开</span>
        </div>
        <i />
      </div>
      <div className="art-calendar">
        <span>物理实验</span>
        <strong>周一</strong>
        <CalendarDays size={22} />
        <small>五人一组，依次轮值</small>
      </div>
      <span className="art-spark">✳</span>
    </div>
  );
}
