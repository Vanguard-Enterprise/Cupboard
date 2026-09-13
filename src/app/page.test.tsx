import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Home from "./page";

describe("home page", () => {
  it("renders the Cupboard application shell", () => {
    expect(renderToStaticMarkup(<Home />)).toContain("Cupboard");
  });
});
