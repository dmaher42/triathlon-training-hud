using Toybox.Activity;
using Toybox.Graphics;
using Toybox.Lang;
using Toybox.WatchUi;

class RunDurabilityView extends WatchUi.DataField {
    var cadence = null;
    var lastCommand = "TAP A CONTROL";
    var transportState = "PHONE BRIDGE";

    function initialize() {
        DataField.initialize();
    }

    function compute(info as Activity.Info) as Numeric or Duration or String or Null {
        cadence = info.currentCadence;
        return cadence == null ? "--" : cadence;
    }

    function setCommandStatus(command as String, status as String) as Void {
        lastCommand = command;
        transportState = status;
        WatchUi.requestUpdate();
    }

    function onUpdate(dc as Dc) as Void {
        var width = dc.getWidth();
        var height = dc.getHeight();
        dc.setColor(Graphics.COLOR_BLACK, Graphics.COLOR_BLACK);
        dc.clear();
        dc.setColor(0x61E6A0, Graphics.COLOR_TRANSPARENT);
        dc.drawText(width / 2, 12, Graphics.FONT_XTINY, "RUN DURABILITY", Graphics.TEXT_JUSTIFY_CENTER);
        dc.setColor(Graphics.COLOR_WHITE, Graphics.COLOR_TRANSPARENT);
        dc.drawText(width / 2, height * 0.20, Graphics.FONT_LARGE, cadence == null ? "--" : cadence.format("%d"), Graphics.TEXT_JUSTIFY_CENTER);
        dc.drawText(width / 2, height * 0.41, Graphics.FONT_XTINY, "CADENCE", Graphics.TEXT_JUSTIFY_CENTER);

        drawControl(dc, 0, height * 0.53, width / 2, height * 0.20, "STATUS");
        drawControl(dc, width / 2, height * 0.53, width / 2, height * 0.20, "WALK / RESUME");
        drawControl(dc, 0, height * 0.73, width / 2, height * 0.20, "QUIET");
        drawControl(dc, width / 2, height * 0.73, width / 2, height * 0.20, "FINISH (2 TAP)");
        dc.setColor(0x9FB6AB, Graphics.COLOR_TRANSPARENT);
        dc.drawText(width / 2, height - 18, Graphics.FONT_XTINY, lastCommand + " - " + transportState, Graphics.TEXT_JUSTIFY_CENTER);
    }

    function drawControl(dc as Dc, x as Numeric, y as Numeric, width as Numeric, height as Numeric, label as String) as Void {
        dc.setColor(0x12382A, Graphics.COLOR_TRANSPARENT);
        dc.fillRoundedRectangle(x + 3, y + 3, width - 6, height - 6, 8);
        dc.setColor(Graphics.COLOR_WHITE, Graphics.COLOR_TRANSPARENT);
        dc.drawText(x + width / 2, y + height / 2 - 8, Graphics.FONT_XTINY, label, Graphics.TEXT_JUSTIFY_CENTER);
    }
}
