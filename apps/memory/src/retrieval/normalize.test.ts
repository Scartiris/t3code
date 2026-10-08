import { describe, expect, it } from "vite-plus/test";

import {
  buildBigramText,
  buildIndexText,
  buildLikePattern,
  buildMatchExpression,
  cjkBigrams,
  isIndexableQuery,
  queryTokens,
} from "./normalize.ts";

describe("CJK index text", () => {
  it("splits a Han run into overlapping bigrams", () => {
    expect(cjkBigrams("部署前先")).toEqual(["部署", "署前", "前先"]);
  });

  it("keeps a lone character so a one-character document is still indexed", () => {
    expect(cjkBigrams("好")).toEqual(["好"]);
  });

  it("finds nothing to split in ascii", () => {
    expect(cjkBigrams("deploy the thing")).toEqual([]);
  });

  it("indexes mixed text as words plus bigrams", () => {
    const grams = buildBigramText(["部署前先跑测试", "Caddy"]);
    expect(grams.split(" ")).toContain("部署");
    expect(grams.split(" ")).toContain("测试");
    expect(grams).not.toContain("Caddy");
  });

  it("drops duplicate grams so the column stays small", () => {
    expect(buildBigramText(["部署", "部署"])).toBe("部署");
  });

  it("lowercases the exact column", () => {
    expect(buildIndexText(["Deploy First"])).toBe("deploy first");
  });
});

describe("query preparation", () => {
  it("expands a two-character Chinese query into its bigram", () => {
    expect(queryTokens("部署")).toEqual(["部署"]);
    expect(buildMatchExpression("部署")).toBe('"部署"');
  });

  it("refuses to answer a bare CJK character from the index", () => {
    expect(isIndexableQuery("部")).toBe(false);
    expect(isIndexableQuery("部署")).toBe(true);
    expect(isIndexableQuery("deploy")).toBe(true);
    expect(isIndexableQuery("?!")).toBe(false);
  });

  it("mixes words and bigrams for a mixed query", () => {
    expect(buildMatchExpression("部署 Caddy")).toBe('"caddy" OR "部署"');
  });

  it("escapes a quote rather than producing a malformed expression", () => {
    expect(buildMatchExpression('say "hi"')).toBe('"say" OR "hi"');
  });

  it("escapes LIKE wildcards in the substring pattern", () => {
    expect(buildLikePattern("50%_off")).toBe("%50!%!_off%");
  });
});
