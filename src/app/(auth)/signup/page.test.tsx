import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import SignupPage from "./page";
import AuthLayout from "../layout";

describe("signup page", () => {
  it("renders the Cupboard account creation form", () => {
    const markup = renderToStaticMarkup(
      <AuthLayout>
        <SignupPage />
      </AuthLayout>,
    );

    expect(markup).toContain("Cupboard");
    expect(markup).toContain("Create an account");
    expect(markup).not.toContain('data-slot="card"');
    expect(markup).toContain('method="post"');
    expect(markup).toContain('action="/signup"');
    expect(markup).toContain('name="name"');
    expect(markup).toContain('name="email"');
    expect(markup).toContain('name="password"');
    expect(markup).toContain('name="confirm-password"');
  });
});
