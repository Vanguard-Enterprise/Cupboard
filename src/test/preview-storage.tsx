import {
  render as testingRender,
  type RenderOptions,
} from "@testing-library/react";
import {
  PreviewStorageProvider,
  previewStorageKey,
} from "@/components/preview-storage";

export const testPreviewKey = (base: string) =>
  previewStorageKey("test-account", "test-organization", base);

export function render(ui: React.ReactNode, options?: RenderOptions) {
  return testingRender(ui, {
    wrapper: ({ children }) => (
      <PreviewStorageProvider
        accountId="test-account"
        organizationId="test-organization"
      >
        {children}
      </PreviewStorageProvider>
    ),
    ...options,
  });
}
