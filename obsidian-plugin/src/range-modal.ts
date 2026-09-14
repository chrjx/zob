import { App, Modal, Setting } from "obsidian";

/** Prompt for a page range (e.g. "101-200") to extract + merge. */
export class RangePromptModal extends Modal {
  private value: string;

  constructor(
    app: App,
    initial: string,
    private onSubmit: (range: string) => void
  ) {
    super(app);
    this.value = initial;
  }

  onOpen() {
    const { contentEl } = this;
    this.setTitle("Extract page range");
    contentEl.createEl("p", {
      text: "Pages to send to MinerU (max 200 per request). Format: 101-200. The result is merged into this paper.",
      cls: "zob-suggestion-meta",
    });

    new Setting(contentEl).setName("Page range").addText((t) => {
      t.setValue(this.value).onChange((v) => (this.value = v.trim()));
      t.inputEl.focus();
      t.inputEl.select();
      t.inputEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter") this.submit();
      });
    });

    new Setting(contentEl).addButton((b) =>
      b
        .setButtonText("Extract")
        .setCta()
        .onClick(() => this.submit())
    );
  }

  private submit() {
    const v = this.value.trim();
    this.close();
    if (v) this.onSubmit(v);
  }

  onClose() {
    this.contentEl.empty();
  }
}
