const test = require('node:test');
const assert = require('node:assert/strict');
const {
  TEAM_CODES,
  normalizeTeamCode,
  reconcileTeamAgentAssignment
} = require('../teamAgentContract');

const members = [
  { id: 'cheikh', name: 'Cheikh Ndiaye', prenom: 'Cheikh', nom: 'Ndiaye', team: 'TZH' },
  { id: 'chantal', name: 'Chantal Löffler', prenom: 'Chantal', nom: 'Löffler', team: 'Team_ZH' },
  { id: 'gnilane-diouf', name: 'Gnilane Diouf', prenom: 'Gnilane', nom: 'Diouf', team: 'TSN' },
  { id: 'gnilane-ndiaye', name: 'Gnilane Ndiaye', prenom: 'Gnilane', nom: 'Ndiaye', team: 'Team_SN' },
  { id: 'ibou', name: 'Ibrahima Ndiaye', preferred_name: 'Ibou', team: 'TSN' }
];

test('normalise les alias des equipes sans transformer une valeur inconnue', () => {
  assert.equal(normalizeTeamCode('TZH'), TEAM_CODES.ZURICH);
  assert.equal(normalizeTeamCode('Team SN'), TEAM_CODES.SENEGAL);
  assert.equal(normalizeTeamCode('Equipe partenaire'), 'Equipe partenaire');
});

test('conserve et canonicalise les collectifs coherents', () => {
  const result = reconcileTeamAgentAssignment({ team: 'TZH', agent: 'Team ZH' }, members);

  assert.equal(result.team, TEAM_CODES.ZURICH);
  assert.equal(result.agent, TEAM_CODES.ZURICH);
  assert.deepEqual(result.errors, []);
});

test('refuse un collectif rattache a une autre equipe', () => {
  const result = reconcileTeamAgentAssignment({ team: 'TSN', agent: 'Team ZH' }, members);

  assert.equal(result.errors[0].code, 'COLLECTIVE_TEAM_MISMATCH');
});

test('refuse un membre RH-001 rattache a une autre equipe', () => {
  const result = reconcileTeamAgentAssignment({ team: 'Team_SN', agent: 'Chantal' }, members);

  assert.equal(result.errors[0].code, 'MEMBER_TEAM_MISMATCH');
});

test('reconnait les noms complets lorsque les prenoms sont ambigus', () => {
  const result = reconcileTeamAgentAssignment({ team: 'TSN', agent: 'Gnilane Ndiaye' }, members);

  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
});

test('signale sans bloquer un agent historique non reconnu', () => {
  const result = reconcileTeamAgentAssignment({ team: 'TZH', agent: 'Agent historique' }, members);

  assert.deepEqual(result.errors, []);
  assert.equal(result.warnings[0].code, 'AGENT_NOT_VERIFIED');
  assert.equal(result.agent, 'Agent historique');
});

test("signale l'indisponibilite RH sans bloquer l'ecriture", () => {
  const result = reconcileTeamAgentAssignment(
    { team: 'TZH', agent: 'Cheikh' },
    [],
    { directoryAvailable: false }
  );

  assert.deepEqual(result.errors, []);
  assert.equal(result.warnings[0].code, 'RH_DIRECTORY_UNAVAILABLE');
});
