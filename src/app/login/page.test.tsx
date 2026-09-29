import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import LoginPage from "./page";

describe("login page", () => {
  it("renders the Cupboard login form", () => {
    const markup = renderToStaticMarkup(<LoginPage />);

    expect(markup).toContain("Cupboard");
    expect(markup).toContain("Sign in to Cupboard");
    expect(markup).toContain('method="post"');
    expect(markup).toContain('action="/login"');
    expect(markup).toContain('id="email"');
    expect(markup).toContain('id="password"');
  });
});
