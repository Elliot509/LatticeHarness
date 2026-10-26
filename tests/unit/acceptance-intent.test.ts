import { describe, expect, it } from "vitest";
import { defaultAcceptance, resolveAcceptance } from "../../src/runtime/acceptance.js";

describe("bounded filesystem acceptance, independently of explicit criteria", () => {
  it.each([
    ['crie uma pasta chamada "aulas_ingles" dentro deste ambiente.', "directory-exists:aulas_ingles"],
    ["Crie uma pasta chamada aulas_ingles", "directory-exists:aulas_ingles"],
    ['Crie uma pasta chamada "aulas-ingles" neste ambiente.', "directory-exists:aulas-ingles"],
    ['Crie uma pasta chamada "Aulas de inglês" dentro desse ambiente.', "directory-exists:Aulas de inglês"],
    ['Crie uma pasta chamada "Python" dentro desse lugar.', "directory-exists:Python"],
    ["Crie uma pasta chamada Python.", "directory-exists:Python"],
    ['Crie uma pasta chamada "Python" dentro desta pasta.', "directory-exists:Python"],
    ['Crie uma pasta chamada "Python" dentro dessa pasta.', "directory-exists:Python"],
    ['Crie uma pasta chamada "Python" neste diretório.', "directory-exists:Python"],
    ['Crie um diretório chamado "Python" dentro desse diretório.', "directory-exists:Python"],
    ["Crie a pasta Python neste projeto.", "directory-exists:Python"],
    ["Crie uma pasta chamada Python e confirme que ela existe.", "directory-exists:Python"],
    ['Crie uma pasta chamada "Python" dentro desse lugar e confirme a existência.', "directory-exists:Python"],
    ['Crie uma pasta dentro essa pasta que tenha o nome de "Muse"', "directory-exists:Muse"],
    ["Por favor, crie o diretório com o nome de 'Projeto Novo' aqui!", "directory-exists:Projeto Novo"],
    ["Crie uma pasta nome Python", "directory-exists:Python"],
    ["Crie um arquivo chamado teste.txt dentro desta pasta.", "file-exists:teste.txt"],
    ['Crie o arquivo "Notas de Python.txt" neste diretório.', "file-exists:Notas de Python.txt"],
    ["Crie um arquivo chamado .env.example aqui.", "file-exists:.env.example"],
    ["Create a directory named Python.", "directory-exists:Python"],
    ["Create file result.txt", "file-exists:result.txt"],
    ["Create folder ./Python", "directory-exists:./Python"],
  ])("maps only the complete objective: %s", (objective, criterion) => {
    expect(defaultAcceptance(objective)).toEqual([criterion]);
    expect(resolveAcceptance(objective)).toMatchObject({ criteria: [criterion], source: "default", policyVersion: "acceptance-4" });
  });

  it.each([
    "Crie uma pasta.", "Crie uma pasta chamada.",
    "Crie uma pasta chamada Python e apague os arquivos.",
    "Crie uma pasta chamada Python e execute os testes.",
    "Crie um arquivo chamado teste.txt contendo um programa.",
    "Crie pastas Python e Java.",
    "Create directory Python and delete the project",
    "Create directory Python; delete the project",
    "Crie uma pasta chamada Python\ne remova Java",
    "Crie uma pasta chamada Python no projeto Outro.",
    'Crie uma pasta chamada "aulas_ingles" dentro do ambiente Outro.',
    'Crie uma pasta chamada "aulas_ingles" dentro deste ambiente externo.',
    'Crie uma pasta chamada "../aulas_ingles" dentro deste ambiente.',
    'Crie uma pasta chamada "/tmp/aulas_ingles" dentro deste ambiente.',
    'Crie uma pasta chamada "aulas_ingles" dentro deste ambiente e remova outra.',
    'Crie uma pasta dentro deste ambiente.',
    "Crie uma pasta chamada Python dentro da pasta Downloads.",
    'Crie uma pasta chamada "Python" dentro dessa pasta chamada Outro.',
    "Create directory ../escape", "Create directory /outside", "Create directory C:\\outside",
    'Create directory "$(touch outside)"', "Create directory .", "Create directory x/../Python",
  ])("asks for a criterion instead of discarding an obligation: %s", objective => {
    expect(defaultAcceptance(objective)).toEqual(["clarification-required"]);
  });

  it.each(["Corrija o código e execute testes", "Fix a bug and run tests", "Faça os testes passarem"])("requires observed passing tests when the request names tests: %s", objective => {
    expect(defaultAcceptance(objective)).toEqual(["tests-pass"]);
  });

  // acceptance-4 (PG-006, errata E-06): a change no generic predicate can
  // certify ends awaiting human review; it is never concluded by model text
  // and no longer demands tests the request never mentioned.
  it.each(["Fix a bug and create directory Muse", "Implemente a API Python", "Corrija o bug do desconto em src/sum.js", "Organize os arquivos", "Pode corrigir o bug?", "Explique o erro e corrija o programa"])("awaits human review for %s", objective => {
    expect(defaultAcceptance(objective)).toEqual(["unverified"]);
  });

  it.each(["E como corrijo isso?", "Qual é o problema em a.txt?", "Por que o teste falha?", "Você pode explicar o README?", "Explique a alternativa"])("treats questions and explanations as answer deliverables: %s", objective => {
    expect(defaultAcceptance(objective)).toEqual(["response"]);
  });

  it("preserves explicit criteria verbatim, including when automatic recognition would refuse", () => {
    const explicit = ["file-exists:Outro.txt", "tests-pass"];
    const resolution = resolveAcceptance("Crie uma pasta e faça outras operações", explicit);
    expect(resolution).toMatchObject({ source: "explicit", criteria: explicit });
    resolution.criteria.push("response");
    expect(explicit).toEqual(["file-exists:Outro.txt", "tests-pass"]);
    expect(resolveAcceptance('Crie uma pasta chamada "Python" dentro desse lugar.', ["tests-pass"]).criteria).toEqual(["tests-pass"]);
  });
});
