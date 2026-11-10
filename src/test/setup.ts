import { configure } from "@testing-library/dom";

// CI runs these tests next to the Rust and image builds on one host. Allow
// slow renders there instead of failing tests that pass on an idle machine.
configure({ asyncUtilTimeout: 5000 });
