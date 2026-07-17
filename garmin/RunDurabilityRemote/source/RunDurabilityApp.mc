using Toybox.Application;
using Toybox.WatchUi;

class RunDurabilityApp extends Application.AppBase {
    function initialize() {
        AppBase.initialize();
    }

    function getInitialView() {
        var view = new RunDurabilityView();
        return [view, new RunDurabilityDelegate(view)];
    }
}

function getApp() as RunDurabilityApp {
    return Application.getApp() as RunDurabilityApp;
}
