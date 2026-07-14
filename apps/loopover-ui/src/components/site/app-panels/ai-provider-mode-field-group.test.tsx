import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AiProviderModeFieldGroup } from "@/components/site/app-panels/ai-provider-mode-field-group";
import type { GeneratorFormState } from "@/lib/config-generator-form-state";
import { gateAiReviewManifestPatch } from "@/lib/config-generator-form-state";

const SECRET_PATTERN = /api[_-]?key|secret|password|sk-ant-|sk-[a-z]/i;

function renderGroup(initial: GeneratorFormState = {}, onChange = vi.fn()) {
  const view = render(<AiProviderModeFieldGroup state={initial} onChange={onChange} />);
  return { onChange, ...view };
}

describe("AiProviderModeFieldGroup", () => {
  it("renders each combine strategy option and patches state on selection", () => {
    const onChange = vi.fn();
    renderGroup({}, onChange);

    expect(screen.getByRole("radio", { name: "single" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "consensus" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "synthesis" })).toBeTruthy();

    fireEvent.click(screen.getByRole("radio", { name: "consensus" }));
    expect(onChange).toHaveBeenCalledWith({
      gate: { aiReview: { combine: "consensus" } },
    });

    fireEvent.click(screen.getByRole("radio", { name: "synthesis" }));
    expect(onChange).toHaveBeenLastCalledWith({
      gate: { aiReview: { combine: "synthesis" } },
    });
  });

  it("edits provider and model fields into gate.aiReview without any secret inputs", () => {
    const onChange = vi.fn();
    renderGroup({ gate: { aiReview: { combine: "single" } } }, onChange);

    expect(screen.queryByLabelText(/api key/i)).toBeNull();
    expect(screen.queryByPlaceholderText(/sk-/i)).toBeNull();
    expect(screen.queryByDisplayValue(/sk-/i)).toBeNull();
    expect(document.querySelector('input[type="password"]')).toBeNull();

    fireEvent.change(screen.getByLabelText(/^provider$/i), { target: { value: "openai" } });
    expect(onChange).toHaveBeenCalledWith({
      gate: { aiReview: { combine: "single", provider: "openai" } },
    });

    fireEvent.change(screen.getByLabelText(/^model/i), { target: { value: "gpt-4.1-mini" } });
    expect(onChange).toHaveBeenLastCalledWith({
      gate: { aiReview: { combine: "single", model: "gpt-4.1-mini" } },
    });

    const emitted = JSON.stringify(onChange.mock.calls);
    expect(emitted).not.toMatch(SECRET_PATTERN);
  });

  it("maps emitted state to manifest keys with no secret fields", () => {
    const state: GeneratorFormState = {
      gate: {
        aiReview: {
          combine: "synthesis",
          provider: "anthropic",
          model: "claude-sonnet-4-20250514",
        },
      },
    };
    const patch = gateAiReviewManifestPatch(state.gate?.aiReview);
    expect(patch).toEqual({
      aiReviewCombine: "synthesis",
      aiReviewProvider: "anthropic",
      aiReviewModel: "claude-sonnet-4-20250514",
    });
    expect(JSON.stringify(patch)).not.toMatch(SECRET_PATTERN);
    expect(Object.keys(patch)).not.toContain("apiKey");
    expect(Object.keys(patch)).not.toContain("key");
  });

  it("shows the secret-handling callout and never renders a secret field in the DOM", () => {
    renderGroup();
    expect(screen.getByText(/API keys stay out of this form/i)).toBeTruthy();
    expect(screen.getByText(/environment variables/i)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(SECRET_PATTERN);
  });
});
