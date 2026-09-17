import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import LoginPage from "./page";
import AuthLayout from "../layout";

describe("login page", () => {
  it("renders the Cupboard login form", () => {
    const markup = renderToStaticMarkup(
      <AuthLayout>
        <LoginPage />
      </AuthLayout>,
    );

    expect(markup).toContain("Cupboard");
    expect(markup).toContain("Login to your account");
    expect(markup).toContain('method="post"');
    expect(markup).toContain('action="/login"');
    expect(markup).toContain('id="email"');
    expect(markup).toContain('id="password"');
  });
});
