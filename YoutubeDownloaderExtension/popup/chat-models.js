/**
 * OpenAI chat models for the Chat tab picker.
 * Metadata is indicative for comparison (input/output $/1M tokens, May 2026).
 *
 * `thinking` is set on GPT-5.x and o-series reasoning models (brain icon in the UI).
 * GPT-4.1 / 4o and other legacy chat models omit it.
 */

export const CHAT_MODEL_CATALOG = [
  {
    group: "Latest flagship",
    models: [
      {
        id: "gpt-5.5",
        name: "GPT-5.5",
        context: "1M",
        price: 4,
        thinking: "MED"
      },
      {
        id: "gpt-5.5-pro",
        name: "GPT-5.5 Pro",
        context: "1M",
        price: 4,
        thinking: "HIGH"
      },
      {
        id: "gpt-5.4",
        name: "GPT-5.4",
        context: "1M",
        price: 3,
        thinking: "MED"
      },
      {
        id: "gpt-5.4-mini",
        name: "GPT-5.4 Mini",
        context: "400K",
        price: 2,
        thinking: "LOW"
      },
      {
        id: "gpt-5.4-nano",
        name: "GPT-5.4 Nano",
        context: "400K",
        price: 1,
        thinking: "LOW"
      },
      {
        id: "gpt-5.2",
        name: "GPT-5.2",
        context: "400K",
        price: 3,
        thinking: "MED"
      },
      {
        id: "gpt-5.1",
        name: "GPT-5.1",
        context: "400K",
        price: 3,
        thinking: "MED"
      },
      {
        id: "gpt-5",
        name: "GPT-5",
        context: "400K",
        price: 3,
        thinking: "MED"
      },
      {
        id: "gpt-5-mini",
        name: "GPT-5 Mini",
        context: "400K",
        price: 2,
        thinking: "LOW"
      },
      {
        id: "gpt-5-nano",
        name: "GPT-5 Nano",
        context: "400K",
        price: 1,
        thinking: "LOW"
      }
    ]
  },
  {
    group: "Reasoning (o-series)",
    models: [
      {
        id: "o3",
        name: "o3",
        context: "200K",
        price: 3,
        thinking: "HIGH"
      },
      {
        id: "o3-pro",
        name: "o3 Pro",
        context: "200K",
        price: 4,
        thinking: "HIGH"
      },
      {
        id: "o3-mini",
        name: "o3-mini",
        context: "200K",
        price: 2,
        thinking: "MED"
      },
      {
        id: "o4-mini",
        name: "o4-mini",
        context: "200K",
        price: 2,
        thinking: "MED"
      },
      {
        id: "o1",
        name: "o1",
        context: "200K",
        price: 4,
        thinking: "HIGH"
      },
      {
        id: "o1-mini",
        name: "o1-mini",
        context: "128K",
        price: 2,
        thinking: "MED"
      },
      {
        id: "o1-pro",
        name: "o1 Pro",
        context: "200K",
        price: 4,
        thinking: "HIGH"
      }
    ]
  },
  {
    group: "GPT-4.1 family",
    models: [
      {
        id: "gpt-4.1",
        name: "GPT-4.1",
        context: "1M",
        price: 3
      },
      {
        id: "gpt-4.1-mini",
        name: "GPT-4.1 Mini",
        context: "1M",
        price: 2
      },
      {
        id: "gpt-4.1-nano",
        name: "GPT-4.1 Nano",
        context: "1M",
        price: 1
      }
    ]
  },
  {
    group: "Legacy & budget",
    models: [
      {
        id: "gpt-4o",
        name: "GPT-4o",
        context: "128K",
        price: 3
      },
      {
        id: "gpt-4o-mini",
        name: "GPT-4o Mini",
        context: "128K",
        price: 1
      }
    ]
  }
];

export const CHAT_MODEL_BY_ID = new Map(
  CHAT_MODEL_CATALOG.flatMap((g) => g.models.map((m) => [m.id, { ...m, group: g.group }]))
);

export const DEFAULT_CHAT_MODEL_ID = "gpt-4.1";

function priceLabel(tier) {
  const n = Math.max(1, Math.min(4, Number(tier) || 1));
  return "$".repeat(n);
}

function escapeHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function modelSupportsThinking(model) {
  return model?.thinking === "HIGH" || model?.thinking === "MED" || model?.thinking === "LOW";
}

function renderThinkingMeta(model) {
  if (!modelSupportsThinking(model)) {
    return "";
  }
  const thinkClass =
    model.thinking === "HIGH"
      ? "think-high"
      : model.thinking === "MED"
        ? "think-med"
        : "think-low";
  return `<span class="model-picker-think ${thinkClass}" title="Reasoning model — uses internal thinking tokens">
      <span class="model-picker-brain" aria-hidden="true">🧠</span>
      <span class="model-picker-think-label">${escapeHtml(model.thinking)}</span>
    </span>`;
}

function renderModelMeta(model) {
  return `<span class="model-picker-meta">
    <span class="model-picker-ctx" title="Context window">${escapeHtml(model.context)}</span>
    <span class="model-picker-price" title="Relative cost (output-heavy workloads)">${priceLabel(model.price)}</span>
    ${renderThinkingMeta(model)}
  </span>`;
}

function renderTriggerContent(model) {
  if (!model) {
    return `<span class="model-picker-trigger-name">Select model…</span>`;
  }
  return `<span class="model-picker-trigger-name">${escapeHtml(model.name)}</span>${renderModelMeta(model)}`;
}

function renderOptionButton(model, selectedId) {
  const selected = model.id === selectedId ? " is-selected" : "";
  return `<button type="button" class="model-picker-option${selected}" data-model-id="${escapeHtml(model.id)}" role="option" aria-selected="${selected ? "true" : "false"}">
    <span class="model-picker-option-name">${escapeHtml(model.name)}</span>
    ${renderModelMeta(model)}
  </button>`;
}

/**
 * @param {{ hiddenInput: HTMLInputElement, root: HTMLElement, onChange?: (id: string) => void }} options
 */
export function initChatModelPicker(options) {
  const hiddenInput = options.hiddenInput;
  const root = options.root;
  if (!hiddenInput || !root) return null;

  const trigger = root.querySelector(".model-picker-trigger");
  const menu = root.querySelector(".model-picker-menu");
  const triggerMain = root.querySelector(".model-picker-trigger-main");
  const listEl = root.querySelector(".model-picker-list");

  if (!trigger || !menu || !triggerMain || !listEl) return null;

  if (!hiddenInput.value) {
    hiddenInput.value = DEFAULT_CHAT_MODEL_ID;
  }

  function buildList() {
    const selectedId = hiddenInput.value;
    const parts = [];
    for (const group of CHAT_MODEL_CATALOG) {
      parts.push(`<div class="model-picker-group-label">${escapeHtml(group.group)}</div>`);
      for (const model of group.models) {
        parts.push(renderOptionButton(model, selectedId));
      }
    }
    listEl.innerHTML = parts.join("");
  }

  function setValue(modelId, { silent = false } = {}) {
    const model = CHAT_MODEL_BY_ID.get(modelId);
    const nextId = model ? model.id : DEFAULT_CHAT_MODEL_ID;
    hiddenInput.value = nextId;
    triggerMain.innerHTML = renderTriggerContent(model || CHAT_MODEL_BY_ID.get(nextId));
    listEl.querySelectorAll(".model-picker-option").forEach((btn) => {
      const isSel = btn.dataset.modelId === nextId;
      btn.classList.toggle("is-selected", isSel);
      btn.setAttribute("aria-selected", isSel ? "true" : "false");
    });
    if (!silent && typeof options.onChange === "function") {
      options.onChange(nextId);
    }
  }

  function closeMenu() {
    menu.hidden = true;
    root.classList.remove("is-open");
    trigger.setAttribute("aria-expanded", "false");
  }

  function openMenu() {
    buildList();
    menu.hidden = false;
    root.classList.add("is-open");
    trigger.setAttribute("aria-expanded", "true");
    const selected = listEl.querySelector(".model-picker-option.is-selected");
    selected?.scrollIntoView({ block: "nearest" });
  }

  function toggleMenu() {
    if (menu.hidden) openMenu();
    else closeMenu();
  }

  buildList();
  setValue(hiddenInput.value, { silent: true });

  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleMenu();
  });

  listEl.addEventListener("click", (e) => {
    const btn = e.target.closest(".model-picker-option");
    if (!btn?.dataset?.modelId) return;
    setValue(btn.dataset.modelId);
    closeMenu();
  });

  document.addEventListener("click", (e) => {
    if (!root.contains(e.target)) closeMenu();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !menu.hidden) {
      closeMenu();
      trigger.focus();
    }
  });

  return { setValue, getValue: () => hiddenInput.value, closeMenu };
}
