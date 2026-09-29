// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import LoginPage from "./page";

describe("login page", () => {
  it("preloads only desktop artwork using the image's responsive sources", () => {
    const document = new DOMParser().parseFromString(
      renderToStaticMarkup(<LoginPage />),
      "text/html",
    );
    const preload = document.querySelector(
      'link[rel="preload"][as="image"][media]',
    );
    const artwork = document.querySelector('img[src*="cupboard-coastal"]');

    expect(preload).not.toBeNull();
    expect(artwork).not.toBeNull();
    expect(preload?.getAttribute("media")).toBe("(min-width: 1024px)");
    expect(preload?.getAttribute("imagesrcset")).toBe(
      artwork?.getAttribute("srcset"),
    );
    expect(preload?.getAttribute("imagesizes")).toBe(
      artwork?.getAttribute("sizes"),
    );
    expect(preload?.getAttribute("fetchPriority")).toBe("high");
    expect(artwork?.getAttribute("loading")).toBe("lazy");
  });

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
