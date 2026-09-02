export type SupportedLocale = "en" | "zh-CN";
export type Translator = (
  key: string,
  values?: InterpolationValues,
  fallbackText?: string,
) => string;

export const DEFAULT_LOCALE: SupportedLocale = "en";

export type InterpolationValues = Record<
  string,
  string | number | boolean | null | undefined
>;

export type TranslationDictionary = {
  workbench: {
    noScopeDescription: string;
    noWorkspaceRepo: string;
    loading: string;
    refresh: string;
    searchPlaceholder: string;
    searchAriaLabel: string;
    empty: string;
    errorPrefix: string;
    unableToLoad: string;
  };
  diagnostics: {
    noViewer: string;
    recheck: string;
    statusHealthy: string;
    statusNotAuthenticated: string;
    statusRateLimited: string;
    statusError: string;
  };
  navigation: {
    tabs: {
      account: string;
      projects: string;
    };
    projectsBanner: string;
    loadingProjects: string;
  };
  summary: {
    total: string;
    pullRequests: string;
    issues: string;
    needsAttention: string;
  };
  sort: {
    updated: string;
    priority: string;
    created: string;
    comments: string;
    directionAsc: string;
    directionDesc: string;
  };
  filters: {
    kinds: {
      all: string;
      pullRequest: string;
      issue: string;
    };
    buckets: {
      all: string;
      needsAttention: string;
      beingHandled: string;
      waiting: string;
      ready: string;
      open: string;
    };
    activeLabel: string;
    clearLabel: string;
    clearAll: string;
    mine: string;
    mineWithCount: string;
    drafts: string;
    draftsWithCount: string;
    activeMilestone: string;
    noMilestone: string;
    clearMilestone: string;
  };
  resource: {
    kind: {
      pullRequest: string;
      issue: string;
    };
    badges: {
      yours: string;
      review: string;
      assigned: string;
      draft: string;
      open: string;
      noRelationship: string;
      ciPassing: string;
      ciRunning: string;
      ciFailing: string;
      approved: string;
      changesRequested: string;
      reviewRequired: string;
      unreviewed: string;
      agentWorking: string;
      agentAttention: string;
      conflicting: string;
    };
    meta: {
      commentsCount: string;
      milestone: string;
      agentSummary: string;
      moreAgents: string;
      linkedReference: string;
    };
    relationships: {
      linkedResource: string;
      focusResource: string;
      clearFocus: string;
      activeFocus: string;
    };
    actions: {
      openAgent: string;
      openWorkspace: string;
      createWorkspace: string;
      creatingWorkspace: string;
      openOnGitHub: string;
      refreshItem: string;
      refreshingItem: string;
      resourceLabel: string;
      expandChecks: string;
      collapseChecks: string;
      selectLabel: string;
      clearLabel: string;
      selectMilestone: string;
      clearMilestone: string;
    };
    toasts: {
      refreshedItem: string;
      refreshFailed: string;
      workspaceCreated: string;
      workspaceOpened: string;
    };
    errors: {
      unableToOpenExternal: string;
      ensureWorkspaceFailed: string;
      localProjectNotFound: string;
      baseBranchUnavailable: string;
    };
  };
  reasons: {
    agentNeedsAttention: string;
    agentFailed: string;
    agentIsWorking: string;
    checksRunning: string;
    yourReviewRequested: string;
    checksFailing: string;
    changesNeeded: string;
    readyToMerge: string;
    waitingForActivity: string;
    waitingForReview: string;
    waitingForMergeability: string;
    assignedToYou: string;
    openIssue: string;
  };
  checksStatus: {
    pending: string;
    success: string;
    failure: string;
    none: string;
    unknown: string;
  };
  checksDetails: {
    title: string;
    showDetails: string;
    hideDetails: string;
    noDetails: string;
    passed: string;
    failed: string;
    pending: string;
    conclusion: string;
  };
  reviewDecision: {
    approved: string;
    changesRequested: string;
    reviewRequired: string;
    none: string;
  };
};
