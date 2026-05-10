export interface TeamLaunchModeInput {
  explicitTeam: boolean;
  explicitProvider: boolean;
  hasProjectTeamContext: boolean;
}

export function shouldRunTeamMode(input: TeamLaunchModeInput): boolean {
  return input.explicitTeam || (!input.explicitProvider && input.hasProjectTeamContext);
}
