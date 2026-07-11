/** FS3 — mention parser boundaries + insertion + server-handle parity. */
import { describe, expect, it } from "vitest";
import { handleFor, insertMention, mentionQueryAt } from "@/lib/virtual/mention";

describe("mentionQueryAt (token boundaries)", () => {
  it("finds a token at the start of the text", () => {
    expect(mentionQueryAt("@gi", 3)).toEqual({ start: 0, query: "gi" });
  });

  it("finds a token after whitespace and a newline", () => {
    expect(mentionQueryAt("ciao @ada", 9)).toEqual({ start: 5, query: "ada" });
    expect(mentionQueryAt("riga\n@b", 7)).toEqual({ start: 5, query: "b" });
  });

  it("a bare @ right before the caret opens an empty query", () => {
    expect(mentionQueryAt("hey @", 5)).toEqual({ start: 4, query: "" });
  });

  it("mid-word @ is NOT a trigger (emails stay emails)", () => {
    expect(mentionQueryAt("mail me at foo@bar", 18)).toBeNull();
  });

  it("whitespace between @ and caret closes the token", () => {
    expect(mentionQueryAt("@ada gi", 7)).toBeNull();
  });

  it("caret inside the token still resolves (partial query up to the caret)", () => {
    expect(mentionQueryAt("@adalovelace", 4)).toEqual({ start: 0, query: "ada" });
  });

  it("handle characters . + - and a domain part stay inside the token", () => {
    expect(mentionQueryAt("@ada.lovelace", 13)).toEqual({ start: 0, query: "ada.lovelace" });
    expect(mentionQueryAt("@ada@factory.it", 15)).toEqual({ start: 0, query: "ada@factory.it" });
  });

  it("no token when the caret is at 0 or out of range", () => {
    expect(mentionQueryAt("@x", 0)).toBeNull();
    expect(mentionQueryAt("@x", 99)).toBeNull();
  });

  it("non-handle character before the caret closes the token", () => {
    expect(mentionQueryAt("@ada,", 5)).toBeNull();
  });
});

describe("insertMention", () => {
  it("replaces the token with `@handle ` and reports the caret after the space", () => {
    const token = { start: 5, query: "ada" };
    const out = insertMention("ciao @ada", token, 9, "ada.lovelace");
    expect(out.text).toBe("ciao @ada.lovelace ");
    expect(out.caret).toBe(19);
  });

  it("preserves text after the caret", () => {
    const token = { start: 0, query: "a" };
    const out = insertMention("@a poi il resto", token, 2, "ada");
    expect(out.text).toBe("@ada  poi il resto");
    expect(out.caret).toBe(5);
  });

  it("works on an empty query token", () => {
    const token = { start: 4, query: "" };
    const out = insertMention("hey @", token, 5, "bruno");
    expect(out.text).toBe("hey @bruno ");
    expect(out.caret).toBe(11);
  });
});

describe("handleFor (server parity — comments.ts resolveMentions dotted rule)", () => {
  it("dots multi-word display names, lowercased", () => {
    expect(handleFor("Ada Lovelace")).toBe("ada.lovelace");
    expect(handleFor("  Bruno   De Rossi ")).toBe("bruno.de.rossi");
  });
  it("single names pass through lowercased", () => {
    expect(handleFor("Ada")).toBe("ada");
  });
});
