using Toybox.Communications;
using Toybox.Lang;
using Toybox.System;
using Toybox.WatchUi;

class RunDurabilityDelegate extends WatchUi.InputDelegate {
    var view;
    var plannedWalkActive = false;
    var finishArmedUntil = 0;
    var requestSequence = 0;

    function initialize(runView as RunDurabilityView) {
        InputDelegate.initialize();
        view = runView;
    }

    function onTap(event as WatchUi.ClickEvent) as Boolean {
        var coordinates = event.getCoordinates();
        var x = coordinates[0];
        var y = coordinates[1];
        var width = System.getDeviceSettings().screenWidth;
        var height = System.getDeviceSettings().screenHeight;
        if (y < height * 0.53) { return false; }

        if (y < height * 0.73 && x < width / 2) {
            sendCommand("status");
        } else if (y < height * 0.73) {
            sendCommand(plannedWalkActive ? "resume" : "planned-walk");
            plannedWalkActive = !plannedWalkActive;
        } else if (x < width / 2) {
            sendCommand("quiet");
        } else {
            var now = System.getTimer();
            if (now <= finishArmedUntil) {
                finishArmedUntil = 0;
                sendCommand("finish-confirm");
            } else {
                finishArmedUntil = now + 8000;
                sendCommand("finish-request");
                view.setCommandStatus("FINISH? TAP AGAIN", "ARMED");
            }
        }
        return true;
    }

    function sendCommand(command as String) as Void {
        requestSequence += 1;
        var message = {
            "type" => "run-control",
            "version" => 1,
            "source" => "garmin",
            "command" => command,
            "requestId" => "fr265-" + requestSequence.format("%d")
        };
        view.setCommandStatus(command.toUpper(), "SENDING");
        Communications.transmit(message, null, method(:onTransmitComplete));
    }

    function onTransmitComplete(status as Communications.ConnectionStatus) as Void {
        view.setCommandStatus(view.lastCommand, status == Communications.CONNECTION_STATUS_SUCCESS ? "SENT" : "PHONE OFFLINE");
    }
}
