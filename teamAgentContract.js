const TEAM_CODES = Object.freeze({
  ZURICH: 'Team_ZH',
  SENEGAL: 'Team_SN'
});

const normalizeLookupKey = (value) => String(value || '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .trim()
  .replace(/[_-]+/g, ' ')
  .replace(/\s+/g, ' ')
  .toUpperCase();

const normalizeTeamCode = (value) => {
  const key = normalizeLookupKey(value).replace(/\s+/g, '_');
  if (['TZH', 'TEAM_ZH', 'TEAMZH', 'ZH'].includes(key)) return TEAM_CODES.ZURICH;
  if (['TSN', 'TEAM_SN', 'TEAMSN', 'SN'].includes(key)) return TEAM_CODES.SENEGAL;
  return String(value || '').trim();
};

const isCanonicalTeam = (value) => Object.values(TEAM_CODES).includes(value);

const getMemberAliases = (member) => [
  member.id,
  member.identifiant,
  member.name,
  member.display_name,
  member.preferred_name,
  member.prenom,
  [member.prenom, member.nom].filter(Boolean).join(' ')
]
  .map(normalizeLookupKey)
  .filter(Boolean);

const findDirectoryMember = (agent, members) => {
  const key = normalizeLookupKey(agent);
  if (!key) return null;

  const matches = members.filter((member) => getMemberAliases(member).includes(key));
  return matches.length === 1 ? matches[0] : null;
};

const reconcileTeamAgentAssignment = ({ team, agent }, members, options = {}) => {
  const directoryAvailable = options.directoryAvailable !== false;
  const normalizedTeam = normalizeTeamCode(team);
  const rawAgent = String(agent || '').trim();
  const collectiveTeam = normalizeTeamCode(rawAgent);
  const warnings = [];
  const errors = [];
  let resolvedTeam = normalizedTeam;
  let resolvedAgent = rawAgent;

  if (resolvedTeam && !isCanonicalTeam(resolvedTeam)) {
    warnings.push({
      code: 'TEAM_NOT_CANONICAL',
      message: `L'equipe « ${resolvedTeam} » n'est pas encore rattachee a Team_ZH ou Team_SN.`
    });
  }

  if (isCanonicalTeam(collectiveTeam)) {
    if (isCanonicalTeam(resolvedTeam) && collectiveTeam !== resolvedTeam) {
      errors.push({
        code: 'COLLECTIVE_TEAM_MISMATCH',
        message: `Le collectif ${collectiveTeam} ne peut pas etre rattache a ${resolvedTeam}.`
      });
    } else if (!resolvedTeam) {
      resolvedTeam = collectiveTeam;
    }
    resolvedAgent = collectiveTeam;
  } else if (rawAgent && directoryAvailable) {
    const directoryMembers = Array.isArray(members) ? members : [];
    const member = findDirectoryMember(rawAgent, directoryMembers);

    if (!member) {
      warnings.push({
        code: 'AGENT_NOT_VERIFIED',
        message: `L'agent « ${rawAgent} » n'a pas pu etre identifie de maniere unique dans RH-001.`
      });
    } else {
      const memberTeam = normalizeTeamCode(member.team || member.department || member.departement);
      if (isCanonicalTeam(memberTeam) && isCanonicalTeam(resolvedTeam) && memberTeam !== resolvedTeam) {
        errors.push({
          code: 'MEMBER_TEAM_MISMATCH',
          message: `L'agent « ${rawAgent} » appartient a ${memberTeam}, pas a ${resolvedTeam}.`
        });
      } else if (!resolvedTeam && isCanonicalTeam(memberTeam)) {
        resolvedTeam = memberTeam;
      }
    }
  } else if (rawAgent && !directoryAvailable) {
    warnings.push({
      code: 'RH_DIRECTORY_UNAVAILABLE',
      message: "RH-001 est indisponible : l'agent est conserve sans verification automatique."
    });
  }

  if (resolvedTeam && !rawAgent) {
    warnings.push({
      code: 'AGENT_MISSING',
      message: "Une equipe est renseignee sans agent individuel ni collectif."
    });
  }

  if (!resolvedTeam && rawAgent) {
    warnings.push({
      code: 'TEAM_MISSING',
      message: "Un agent est renseigne sans equipe rattachee."
    });
  }

  return {
    team: resolvedTeam,
    agent: resolvedAgent,
    warnings,
    errors
  };
};

module.exports = {
  TEAM_CODES,
  normalizeTeamCode,
  reconcileTeamAgentAssignment
};
