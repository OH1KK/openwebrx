function DemodulatorPanel(el) {
    var self = this;
    self.el = el;
    self.demodulator = null;

    var displayEl = el.find('.webrx-actual-freq')
    this.tuneableFrequencyDisplay = displayEl.tuneableFrequencyDisplay();
    displayEl.on('frequencychange', function(event, freq) {
        self.getDemodulator().set_offset_frequency(freq - self.center_freq);
    });

    Modes.registerModePanel(this);
    el.on('click', '.openwebrx-demodulator-button', function() {
        var modulation = $(this).data('modulation');
        if (modulation) {
            self.setMode(modulation);
        } else {
            self.disableDigiMode();
        }
    });
    el.on('change', '.openwebrx-secondary-demod-listbox', function() {
        var value = $(this).val();
        if (value === 'none') {
            self.disableDigiMode();
        } else {
            self.setMode(value);
        }
    });
    window.addEventListener('hashchange', function() {
        self.onHashChange();
    });
};

DemodulatorPanel.prototype.render = function() {
    var available = Modes.getModes().filter(function(m){ return m.isAvailable(); });
    var normalModes = available.filter(function(m){ return m.type === 'analog'; });
    var digiModes = available.filter(function(m){ return m.type === 'digimode'; });

    var html = []

    var buttons = normalModes.map(function(m){
        return $(
            '<div ' +
                'class="openwebrx-button openwebrx-demodulator-button" ' +
                'data-modulation="' + m.modulation + '" ' +
                'id="openwebrx-button-' + m.modulation + '" r' +
            '>' + m.name + '</div>'
        );
    });

    var index = 0;
    var arrayLength = buttons.length;
    var chunks = [];

    for (index = 0; index < arrayLength; index += 5) {
        chunks.push(buttons.slice(index, index + 5));
    }

    html.push.apply(html, chunks.map(function(chunk){
        $line = $('<div class="openwebrx-panel-line openwebrx-panel-flex-line"></div>');
        $line.append.apply($line, chunk);
        return $line
    }));

    html.push($(
        '<div class="openwebrx-panel-line openwebrx-panel-flex-line">' +
            '<div class="openwebrx-button openwebrx-demodulator-button openwebrx-button-dig">DIG</div>' +
            '<select class="openwebrx-secondary-demod-listbox">' +
                '<option value="none"></option>' +
                digiModes.map(function(m){
                    return '<option value="' + m.modulation + '">' + m.name + '</option>';
                }).join('') +
            '</select>' +
        '</div>'
    ));

    this.el.find(".openwebrx-modes").html(html);
};

DemodulatorPanel.prototype.setMode = function(modulation) {
    var mode = Modes.findByModulation(modulation);
    if (!mode) {
        return;
    }
    if (!mode.isAvailable()) {
        divlog('Modulation "' + mode.name + '" not supported. Please check requirements', true);
        return;
    }

    if (mode.type === 'digimode') {
        modulation = mode.underlying[0];
    }

    var current_offset_frequency = 0;
    var current_modulation = false;
    if (this.demodulator) {
        current_modulation = this.demodulator.get_modulation();
        current_offset_frequency = this.demodulator.get_offset_frequency();
    }

    var replace_modulator = current_modulation !== modulation;
    if (replace_modulator) {
        this.stopDemodulator();
        this.demodulator = new Demodulator(current_offset_frequency, modulation);
        var self = this;
        this.demodulator.on("frequencychange", function(freq) {
            self.tuneableFrequencyDisplay.setFrequency(self.center_freq + freq);
            self.updateHash();
        });
    }
    if (mode.type === 'digimode') {
        this.demodulator.set_secondary_demod(mode.modulation);
    } else {
        this.demodulator.set_secondary_demod(false);
    }

    if (replace_modulator) {
        this.demodulator.start();
    }

    this.updateButtons();
    this.updatePanels();
    this.updateHash();
};

DemodulatorPanel.prototype.disableDigiMode = function() {
    var modulation = this.el.find('.openwebrx-button.highlighted[data-modulation]').data('modulation');
    this.setMode(modulation);
};

DemodulatorPanel.prototype.updatePanels = function() {
    var modulation = this.getDemodulator().get_secondary_demod();
    $('#openwebrx-panel-digimodes').attr('data-mode', modulation);
    toggle_panel("openwebrx-panel-digimodes", !!modulation);
    toggle_panel("openwebrx-panel-wsjt-message", ['ft8', 'wspr', 'jt65', 'jt9', 'ft4'].indexOf(modulation) >= 0);
    toggle_panel("openwebrx-panel-js8-message", modulation == "js8");
    toggle_panel("openwebrx-panel-packet-message", modulation === "packet");
    toggle_panel("openwebrx-panel-pocsag-message", modulation === "pocsag");
};

DemodulatorPanel.prototype.getDemodulator = function() {
    return this.demodulator;
};

DemodulatorPanel.prototype.startDemodulator = function() {
    if (!Modes.initComplete()) return;
    var params = $.extend({}, this.initialParams || {}, this.transformHashParams(this.parseHash()));
    this._apply(params);
};

DemodulatorPanel.prototype.stopDemodulator = function() {
    if (!this.demodulator) {
        return;
    }
    this.demodulator.stop();
    this.demodulator = false;
}

DemodulatorPanel.prototype._apply = function(params) {
    this.setMode(params.mod);
    this.getDemodulator().set_offset_frequency(params.offset_frequency);
    this.updateButtons();
};

DemodulatorPanel.prototype.setInitialParams = function(params) {
    this.initialParams = params;
};

DemodulatorPanel.prototype.onHashChange = function() {
    this._apply(this.transformHashParams(this.parseHash()));
};

DemodulatorPanel.prototype.transformHashParams = function(params) {
    return {
        mod: params.secondary_mod || params.mod,
        offset_frequency: params.offset_frequency
    };
};

DemodulatorPanel.prototype.updateButtons = function() {
    var $buttons = this.el.find(".openwebrx-demodulator-button");
    $buttons.removeClass("highlighted").removeClass('disabled');
    var demod = this.getDemodulator()
    if (!demod) return;
    this.el.find('[data-modulation=' + demod.get_modulation() + ']').addClass("highlighted");
    var secondary_demod = demod.get_secondary_demod()
    if (secondary_demod) {
        this.el.find(".openwebrx-button-dig").addClass("highlighted");
        this.el.find('.openwebrx-secondary-demod-listbox').val(secondary_demod);
        var mode = Modes.findByModulation(secondary_demod);
        if (mode) {
            $buttons.filter(function(){
                var mod = $(this).data('modulation');
                return mod && mode.underlying.indexOf(mod) < 0;
            }).addClass('disabled');
        }
    } else {
        this.el.find('.openwebrx-secondary-demod-listbox').val('none');
    }
}

DemodulatorPanel.prototype.setCenterFrequency = function(center_freq) {
    if (this.center_freq === center_freq) {
        return;
    }
    this.stopDemodulator();
    this.center_freq = center_freq;
    this.startDemodulator();
};

DemodulatorPanel.prototype.parseHash = function() {
    if (!window.location.hash) {
        return {};
    }
    var params = window.location.hash.substring(1).split(",").map(function(x) {
        var harr = x.split('=');
        return [harr[0], harr.slice(1).join('=')];
    }).reduce(function(params, p){
        params[p[0]] = p[1];
        return params;
    }, {});

    return this.validateHash(params);
};

DemodulatorPanel.prototype.validateHash = function(params) {
    var self = this;
    params = Object.keys(params).filter(function(key) {
        if (key == 'freq' || key == 'mod' || key == 'secondary_mod') {
            return params.freq && Math.abs(params.freq - self.center_freq) < bandwidth;
        }
        return true;
    }).reduce(function(p, key) {
        p[key] = params[key];
        return p;
    }, {});

    if (params['freq']) {
        params['offset_frequency'] = params['freq'] - self.center_freq;
        delete params['freq'];
    }

    return params;
};

DemodulatorPanel.prototype.updateHash = function() {
    var demod = this.getDemodulator();
    if (!demod) return;
    var self = this;
    window.location.hash = $.map({
        freq: demod.get_offset_frequency() + self.center_freq,
        mod: demod.get_modulation(),
        secondary_mod: demod.get_secondary_demod()
    }, function(value, key){
        if (!value) return undefined;
        return key + '=' + value;
    }).filter(function(v) {
        return !!v;
    }).join(',');
};

$.fn.demodulatorPanel = function(){
    if (!this.data('panel')) {
        this.data('panel', new DemodulatorPanel(this));
    };
    return this.data('panel');
};