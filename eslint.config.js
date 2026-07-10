import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "docs/design-system/**"] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Architecture guardrail: the background worker owns Supabase auth and all
    // API calls. Nothing else may import supabase-js — the side panel and
    // content script talk to the background over chrome runtime messaging only.
    files: ["src/sidepanel/**", "src/content/**", "src/shared/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@supabase/supabase-js",
              message: "Only the background worker may touch Supabase auth.",
            },
          ],
        },
      ],
    },
  },
);
