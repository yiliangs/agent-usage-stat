export function selectPortalView(navigation, requestedView) {
  const { currentView, settingsReturnView } = navigation

  if (requestedView === 'settings') {
    if (currentView === 'settings' && settingsReturnView) {
      return { currentView: settingsReturnView, settingsReturnView: null }
    }

    return {
      currentView: 'settings',
      settingsReturnView: currentView === 'settings' ? null : currentView,
    }
  }

  return { currentView: requestedView, settingsReturnView: null }
}
