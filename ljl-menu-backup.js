function () {

    return new Promise(async (resolve, reject) => {

        const ai_create_file_items = []
        function makeAiCreateItem(label, handlerAsync) {
            return {
                label,
                ionfunction: createIonFunction(handlerAsync),
                click: () => {
                    handlerAsync()
                },
            };
        }

        ai_create_file_items.push(
            makeAiCreateItem('Historical Milestones', async () => {
                let sequenceTextEditor;
                let descHook = createIonFunction((p) => {
                    sequenceTextEditor = p;
                });

                const txtOptions = [
                    "What is the history of therapeutics targeting BRCA1 mutations?",
                    "What is the history of gene therapies for CFTR mutations?",
                    "What is the history of RNA-based drugs for KRAS variants?",
                    "What is the history of therapies targeting TP53 mutations?",
                    "What is the history of antisense oligonucleotides for exon-skipping mutations?",
                    "What is the history of therapeutics for EGFR mutations?",
                    "What is the history of gene-editing therapies for sickle cell mutations?",
                    "What is the history of mRNA therapies for rare genetic disorders?",
                    "What is the history of ASOs targeting splice-site mutations?",
                    "What is the history of RNA therapeutics for oncogenic mutations?",
                    "What is the history of therapies targeting inherited gene mutations?",
                    "What is the history of CRISPR-based treatments for point mutations?",
                    "What is the history of mRNA therapeutics for metabolic gene defects?",
                    "What is the history of therapies targeting frameshift mutations?",
                    "What is the history of siRNA therapeutics for gain-of-function mutations?",
                    "What is the history of gene therapies for loss-of-function mutations?",
                    "What is the history of mRNA therapies for tumor suppressor restoration?",
                    "What is the history of therapeutics targeting pathogenic variants?",
                    "What is the history of siRNA therapies for dominant-negative mutations?",
                    "What is the history of RNA therapies for genetic disorders?",
                    "What is the history of antisense drugs for mutation correction?",
                    "What is the history of gene therapies targeting single-nucleotide variants?",
                    "What is the history of siRNA candidates for oncogenic driver mutations?",
                    "What is the history of RNA therapies for rare mutations?",
                    "What is the history of ASOs targeting splicing mutations?",
                    "What is the history of mRNA therapies for inherited diseases?",
                    "What is the history of siRNA treatments for mutation silencing?",
                    "What is the history of therapeutics for genetic variants?",
                    "What is the history of RNA molecules targeting mutation hotspots?",
                    "What is the history of mRNA therapies for regenerative gene repair?",
                    "What is the history of siRNA therapies for mutated oncogenes?",
                    "What is the history of ASOs for mutation-specific targeting?",
                    "What is the history of RNA therapeutics for variant correction?",
                    "What is the history of mutation-targeted drug candidates?",
                    "What is the history of therapeutics for gene mutation repair?",
                    "What is the history of siRNA candidates for mutation knockdown?",
                    "What is the history of RNA constructs for mutation targeting?",
                    "What is the history of mRNA therapies for genetic mutations?",
                    "What is the history of ASOs for allele-specific mutation targeting?",
                    "What is the history of siRNA therapeutics for variant suppression?",
                    "What is the history of RNA therapies for mutation correction?",
                    "What is the history of mRNA candidates for gene restoration?",
                    "What is the history of antisense drugs for mutation repair?",
                    "What is the history of RNA therapeutics targeting variants?",
                    "What is the history of siRNA constructs for mutation silencing?",
                    "What is the history of mRNA therapies for gene correction?",
                    "What is the history of ASO drugs for mutation targeting?",
                    "What is the history of RNA candidates for variant-specific therapy?",
                    "What is the history of mRNA therapeutics for gene mutations?",
                    "What is the history of siRNA constructs for mutation knockdown?",
                    "What is the history of antisense molecules for variant correction?",
                    "What is the history of RNA therapeutics for mutation repair?",
                    "What is the history of siRNA constructs for mutation targeting?",
                    "What is the history of mRNA therapeutics for gene defects?",
                    "What is the history of mRNA drug candidates for mutation correction?",
                    "What is the history of antisense molecules for variant targeting?",
                    "What is the history of siRNA therapeutics for mutation silencing?",
                    "What is the history of RNA interference molecules for mutations?",
                    "What is the history of mRNA candidates for genetic disorders?",
                    "What is the history of ASOs for mutation-specific targeting?",
                    "What is the history of siRNA therapies for gene variants?",
                    "What is the history of RNAi candidates for mutation suppression?",
                    "What is the history of antisense oligonucleotides for mutations?",
                    "What is the history of mRNA candidates for gene correction?",
                    "What is the history of siRNA constructs for variant targeting?",
                    "What is the history of antisense oligonucleotides for mutation repair?",
                    "What is the history of RNAi therapies for genetic mutations?",
                    "What is the history of mRNA therapeutics for variant correction?",
                    "What is the history of siRNA molecules for mutation knockdown?",
                    "What is the history of antisense therapeutics for gene mutations?",
                    "What is the history of RNAi therapeutics for mutation silencing?",
                    "What is the history of mRNA drug candidates for variant repair?",
                    "What is the history of antisense molecules for gene variants?",
                    "What is the history of siRNA therapeutics for mutation targeting?",
                    "What is the history of RNAi molecules for mutation suppression?",
                    "What is the history of antisense drugs for genetic mutations?"
                ];

                const txt = txtOptions[Math.floor(Math.random() * txtOptions.length)];

                let initalText = true;
                setTimeout(() => {
                    let i = 0;
                    let currentText = '';

                    const interval = setInterval(() => {

                        currentText += txt[i];
                        if (!initalText) {
                            sequenceTextEditor.setContent('');
                            clearInterval(interval);
                            return;
                        }
                        sequenceTextEditor.setContent(currentText);
                        i++;

                        if (i >= txt.length) {
                            clearInterval(interval);
                        }
                    }, 5);
                }, 1500);

                let sequence_input = {
                    wid: 'card',
                    height: '200px',
                    data: {
                        'style.padding-top': '1px',
                        'style.border': '1px',
                        'style.height': '200px',
                        cards: [
                            [
                                {
                                    width: '100%',
                                    component: {
                                        wid: 'html',
                                        data: `<hr>
    <H4>
    <font color="navy">Write a short paragraph that describes the timeline you want to create.  (BCE currently not supported)</font>
    </H4>

                                                    <hr>

                                                    `,
                                    },
                                },
                                {
                                    width: '100%',
                                    component: {
                                        wid: 'text-editor',
                                        refCallback: descHook,
                                        data: {
                                            height: '200px',
                                            showButton: false,
                                            editorOptions: {
                                                value: '',
                                                language: 'text',
                                                automaticLayout: true,
                                                fontSize: 24,
                                                lineNumbers: 'off',
                                                suggestOnTriggerCharacters: false,
                                                quickSuggestions: false,
                                                parameterHints: { enabled: false },
                                                minimap: { enabled: false },
                                                fontFamily: 'Courier New, monospace',
                                                placeholder:
                                                    'Enter a paragraph that describes the timeline you want to create.  For example:  I want to create a timeline that describes important milestones about Vasco De Gamma around the Cape of Good Hope',
                                                cursorStyle: 'block',
                                            },
                                            onDidFocusEditorWidget: createIon(() => {
                                                if (initalText) sequenceTextEditor.setContent('');
                                                initalText = false;
                                            }),
                                            keybinding: {
                                                'Ctrl+Enter': createIonFunction((content, lineNumber, col) => { }),
                                            },
                                        },
                                    },
                                },
                                {
                                    component: {
                                        wid: 'mt-button',
                                        data: {
                                            buttons: [
                                                {
                                                    label: 'Cancel',
                                                    ionFunction: createIonFunction(async () => {
                                                        hideAllModal();
                                                        CurrentLayout.reset('mainPanel');
                                                    }),
                                                },
                                                {
                                                    label: 'Build timeline',
                                                    ionFunction: createIonFunction(async () => {
                                                        hideAllModal();
                                                        CurrentLayout.reset('mainPanel');
                                                        setTimeout(async () => {
                                                            let interval = null;
                                                            let em = new EngineMonitor((msg) => {
                                                                pm.plateTrack.updateSprite(msg);
                                                            });
                                                            em.addProgressListener(async (v) => {
                                                                if (v >= 100) {
                                                                }
                                                            });
                                                            let content = sequenceTextEditor.getContent();
                                                            pm.plateTrack.setMessage('Building model', 5);
                                                            let model = await exec('py/openai/milestones.py', em, content);
                                                            pm.plateTrack.killSprite();
                                                            if (model && model.milestones) {
                                                                if (model.milestones.length === 0) {
                                                                    infoPrompt('No milestones found');
                                                                    return;
                                                                }

                                                                let MPlot = await exec('flexigraph/plot.js');
                                                                const plot = new MPlot({ points: model.milestones });

                                                                function jdnFromYMD(y, m, d) {
                                                                    const a = Math.floor((14 - m) / 12);
                                                                    const y2 = y + 4800 - a;
                                                                    const m2 = m + 12 * a - 3;
                                                                    return (
                                                                        d +
                                                                        Math.floor((153 * m2 + 2) / 5) +
                                                                        365 * y2 +
                                                                        Math.floor(y2 / 4) -
                                                                        Math.floor(y2 / 100) +
                                                                        Math.floor(y2 / 400) -
                                                                        32045
                                                                    );
                                                                }

                                                                function parseProlepticDate(isoString) {
                                                                    if (typeof isoString !== 'string') return new Date(NaN);
                                                                    isoString = isoString.replace(/\u2212|−/g, '-').trim();

                                                                    const m = isoString.match(
                                                                        /^([+-]?\d{1,6})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2})(?::(\d{2}))?)?$/
                                                                    );
                                                                    if (!m) {
                                                                        const d = new Date(isoString);
                                                                        return isNaN(d) ? new Date(NaN) : d;
                                                                    }

                                                                    const year = parseInt(m[1], 10);
                                                                    const month1 = parseInt(m[2], 10);
                                                                    const day = parseInt(m[3], 10);
                                                                    const hour = m[4] ? parseInt(m[4], 10) : 0;
                                                                    const minute = m[5] ? parseInt(m[5], 10) : 0;
                                                                    const second = m[6] ? parseInt(m[6], 10) : 0;

                                                                    if (
                                                                        month1 < 1 ||
                                                                        month1 > 12 ||
                                                                        day < 1 ||
                                                                        day > 31 ||
                                                                        hour < 0 ||
                                                                        hour > 23 ||
                                                                        minute < 0 ||
                                                                        minute > 59 ||
                                                                        second < 0 ||
                                                                        second > 59
                                                                    )
                                                                        return new Date(NaN);

                                                                    const jdn = jdnFromYMD(year, month1, day);
                                                                    const epochJDN = 2440588;
                                                                    const secondsSinceEpoch =
                                                                        (jdn - epochJDN) * 86400 +
                                                                        (hour * 3600 + minute * 60 + second);
                                                                    const ms = secondsSinceEpoch * 1000;

                                                                    return new Date(ms);
                                                                }

                                                                plot.startDate = parseProlepticDate(model.window.start);
                                                                plot.endDate = parseProlepticDate(model.window.end);

                                                                if (isMobile()) {
                                                                    plot.maximize = true;
                                                                }

                                                                let xs = model.milestones.map((p) => p.x);
                                                                const xMin = Math.min(...xs);
                                                                const xMax = Math.max(...xs);
                                                                plot.grid.zoom(xMin, xMax, 0, 1);
                                                                plot.w = 800;
                                                                plot.h = 400;

                                                                plot.type = 'timeline';
                                                                plot.name = generateNautName();
                                                                plot.x_axis_label = 'Time (Years)';
                                                                plot.y_axis_label = 'Sample Metric';
                                                                plot.fitScaleToData = false;
                                                                plot.grid.rescale();

                                                                await pm.plateTrack.panToNextSpot(800);
                                                                pm.plateTrack.setPlotCenter(plot);
                                                            } else {
                                                                infoPrompt(' Failed to build the model');
                                                            }
                                                        }, 1000);
                                                    }),
                                                },
                                            ],
                                        },
                                    },
                                },
                            ],
                        ],
                    },
                };
                CurrentLayout.setComponent('mainPanel', sequence_input);
            })
        );

        ai_create_file_items.push(
            makeAiCreateItem('Publications Timeline', async () => {
                let sequenceTextEditor;
                let descHook = createIonFunction((p) => {
                    sequenceTextEditor = p;
                });

                const txtOptions = [
                    "Give me relevant publications for therapeutics targeting BRCA1 mutations.",
                    "Give me relevant publications for gene therapies for CFTR mutations.",
                    "Give me relevant publications for RNA-based drugs for KRAS variants.",
                    "Give me relevant publications for therapies targeting TP53 mutations.",
                    "Give me relevant publications for antisense oligonucleotides for exon-skipping mutations.",
                    "Give me relevant publications for therapeutics for EGFR mutations.",
                    "Give me relevant publications for gene-editing therapies for sickle cell mutations.",
                    "Give me relevant publications for mRNA therapies for rare genetic disorders.",
                    "Give me relevant publications for ASOs targeting splice-site mutations.",
                    "Give me relevant publications for RNA therapeutics for oncogenic mutations.",
                    "Give me relevant publications for therapies targeting inherited gene mutations.",
                    "Give me relevant publications for CRISPR-based treatments for point mutations.",
                    "Give me relevant publications for mRNA therapeutics for metabolic gene defects.",
                    "Give me relevant publications for therapies targeting frameshift mutations.",
                    "Give me relevant publications for siRNA therapeutics for gain-of-function mutations.",
                    "Give me relevant publications for gene therapies for loss-of-function mutations.",
                    "Give me relevant publications for mRNA therapies for tumor suppressor restoration.",
                    "Give me relevant publications for therapeutics targeting pathogenic variants.",
                    "Give me relevant publications for siRNA therapies for dominant-negative mutations.",
                    "Give me relevant publications for RNA therapies for genetic disorders.",
                    "Give me relevant publications for antisense drugs for mutation correction.",
                    "Give me relevant publications for gene therapies targeting single-nucleotide variants.",
                    "Give me relevant publications for siRNA candidates for oncogenic driver mutations.",
                    "Give me relevant publications for RNA therapies for rare mutations.",
                    "Give me relevant publications for ASOs targeting splicing mutations.",
                    "Give me relevant publications for mRNA therapies for inherited diseases.",
                    "Give me relevant publications for siRNA treatments for mutation silencing.",
                    "Give me relevant publications for therapeutics for genetic variants.",
                    "Give me relevant publications for RNA molecules targeting mutation hotspots.",
                    "Give me relevant publications for mRNA therapies for regenerative gene repair.",
                    "Give me relevant publications for siRNA therapies for mutated oncogenes.",
                    "Give me relevant publications for ASOs for mutation-specific targeting.",
                    "Give me relevant publications for RNA therapeutics for variant correction.",
                    "Give me relevant publications for mutation-targeted drug candidates.",
                    "Give me relevant publications for therapeutics for gene mutation repair.",
                    "Give me relevant publications for siRNA candidates for mutation knockdown.",
                    "Give me relevant publications for RNA constructs for mutation targeting.",
                    "Give me relevant publications for mRNA therapies for genetic mutations.",
                    "Give me relevant publications for ASOs for allele-specific mutation targeting.",
                    "Give me relevant publications for siRNA therapeutics for variant suppression.",
                    "Give me relevant publications for RNA therapies for mutation correction.",
                    "Give me relevant publications for mRNA candidates for gene restoration.",
                    "Give me relevant publications for antisense drugs for mutation repair.",
                    "Give me relevant publications for RNA therapeutics targeting variants.",
                    "Give me relevant publications for siRNA constructs for mutation silencing.",
                    "Give me relevant publications for mRNA therapies for gene correction.",
                    "Give me relevant publications for ASO drugs for mutation targeting.",
                    "Give me relevant publications for RNA candidates for variant-specific therapy.",
                    "Give me relevant publications for mRNA therapeutics for gene mutations.",
                    "Give me relevant publications for siRNA constructs for mutation knockdown.",
                    "Give me relevant publications for antisense molecules for variant correction.",
                    "Give me relevant publications for RNA therapeutics for mutation repair.",
                    "Give me relevant publications for siRNA constructs for mutation targeting.",
                    "Give me relevant publications for mRNA therapeutics for gene defects.",
                    "Give me relevant publications for mRNA drug candidates for mutation correction.",
                    "Give me relevant publications for antisense molecules for variant targeting.",
                    "Give me relevant publications for siRNA therapeutics for mutation silencing.",
                    "Give me relevant publications for RNA interference molecules for mutations.",
                    "Give me relevant publications for mRNA candidates for genetic disorders.",
                    "Give me relevant publications for ASOs for mutation-specific targeting.",
                    "Give me relevant publications for siRNA therapies for gene variants.",
                    "Give me relevant publications for RNAi candidates for mutation suppression.",
                    "Give me relevant publications for antisense oligonucleotides for mutations.",
                    "Give me relevant publications for mRNA candidates for gene correction.",
                    "Give me relevant publications for siRNA constructs for variant targeting.",
                    "Give me relevant publications for antisense oligonucleotides for mutation repair.",
                    "Give me relevant publications for RNAi therapies for genetic mutations.",
                    "Give me relevant publications for mRNA therapeutics for variant correction.",
                    "Give me relevant publications for siRNA molecules for mutation knockdown.",
                    "Give me relevant publications for antisense therapeutics for gene mutations.",
                    "Give me relevant publications for RNAi therapeutics for mutation silencing.",
                    "Give me relevant publications for mRNA drug candidates for variant repair.",
                    "Give me relevant publications for antisense molecules for gene variants.",
                    "Give me relevant publications for siRNA therapeutics for mutation targeting.",
                    "Give me relevant publications for RNAi molecules for mutation suppression.",
                    "Give me relevant publications for antisense drugs for genetic mutations."
                ];

                const txt = txtOptions[Math.floor(Math.random() * txtOptions.length)];
                let initalText = true;
                setTimeout(() => {
                    let i = 0;
                    let currentText = '';

                    const interval = setInterval(() => {
                        currentText += txt[i];
                        if (!initalText) {
                            sequenceTextEditor.setContent('');
                            clearInterval(interval);
                            return;
                        }
                        sequenceTextEditor.setContent(currentText);
                        i++;

                        if (i >= txt.length) {
                            clearInterval(interval);
                        }
                    }, 100);
                }, 50);

                let sequence_input = {
                    wid: 'card',
                    height: '200px',
                    data: {
                        'style.padding-top': '1px',
                        'style.border': '1px',
                        'style.height': '200px',
                        cards: [
                            [
                                {
                                    width: '100%',
                                    component: {
                                        wid: 'html',
                                        data: `<hr>
    <H4>
    <font color="navy">Write a short paragraph that describes the timeline you want to create. </font>
    </H4>

                                                    <hr>

                                                    `,
                                    },
                                },
                                {
                                    width: '100%',
                                    component: {
                                        wid: 'text-editor',
                                        refCallback: descHook,
                                        data: {
                                            height: '200px',

                                            showButton: false,
                                            editorOptions: {
                                                value: '',
                                                language: 'text',
                                                automaticLayout: true,
                                                fontSize: 24,
                                                lineNumbers: 'off',
                                                suggestOnTriggerCharacters: false,
                                                quickSuggestions: false,
                                                parameterHints: { enabled: false },
                                                minimap: { enabled: false },
                                                fontFamily: 'Courier New, monospace',
                                                placeholder:
                                                    'Enter a paragraph that describes the timeline you want to create.  For example:  I want to create a timeline that describes important milestones about Vasco De Gamma around the Cape of Good Hope',
                                                cursorStyle: 'block',
                                            },
                                            onDidFocusEditorWidget: createIon(() => {
                                                if (initalText) sequenceTextEditor.setContent('');
                                                initalText = false;
                                            }),
                                            keybinding: {
                                                'Ctrl+Enter': createIonFunction((content, lineNumber, col) => { }),
                                            },
                                        },
                                    },
                                },
                                {
                                    width: '100%',
                                    component: {
                                        wid: 'html',
                                        data: '<hr>',
                                    },
                                },
                                {
                                    component: {
                                        wid: 'mt-button',
                                        data: {
                                            buttons: [
                                                {
                                                    label: 'Cancel',
                                                    ionFunction: createIonFunction(async () => {
                                                        hideAllModal();
                                                        CurrentLayout.reset('mainPanel');
                                                    }),
                                                },
                                                {
                                                    label: 'Build timeline',
                                                    ionFunction: createIonFunction(async () => {
                                                        hideAllModal();
                                                        CurrentLayout.reset('mainPanel');
                                                        setTimeout(async () => {
                                                            let interval = null;
                                                            let em = new EngineMonitor((msg) => {
                                                                pm.plateTrack.updateSprite(msg);
                                                            });
                                                            em.addProgressListener(async (v) => {
                                                                if (v >= 100) {
                                                                }
                                                            });
                                                            let content = sequenceTextEditor.getContent();
                                                            pm.plateTrack.setMessage('Building model', 5);
                                                            let model = await exec('py/openai/sci-pub-milestones.py', em, content);
                                                            pm.plateTrack.killSprite();

                                                            if (model && model.results.milestones && model.results.milestones.length > 0) {
                                                                let MPlot = await exec('flexigraph/plot.js');
                                                                const plot = new MPlot({ points: model.results.milestones });

                                                                function jdnFromYMD(y, m, d) {
                                                                    const a = Math.floor((14 - m) / 12);
                                                                    const y2 = y + 4800 - a;
                                                                    const m2 = m + 12 * a - 3;
                                                                    return (
                                                                        d +
                                                                        Math.floor((153 * m2 + 2) / 5) +
                                                                        365 * y2 +
                                                                        Math.floor(y2 / 4) -
                                                                        Math.floor(y2 / 100) +
                                                                        Math.floor(y2 / 400) -
                                                                        32045
                                                                    );
                                                                }

                                                                function parseProlepticDate(isoString) {
                                                                    if (typeof isoString !== 'string') return new Date(NaN);
                                                                    isoString = isoString.replace(/\u2212|−/g, '-').trim();

                                                                    const m = isoString.match(
                                                                        /^([+-]?\d{1,6})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2})(?::(\d{2}))?)?$/
                                                                    );
                                                                    if (!m) {
                                                                        const d = new Date(isoString);
                                                                        return isNaN(d) ? new Date(NaN) : d;
                                                                    }

                                                                    const year = parseInt(m[1], 10);
                                                                    const month1 = parseInt(m[2], 10);
                                                                    const day = parseInt(m[3], 10);
                                                                    const hour = m[4] ? parseInt(m[4], 10) : 0;
                                                                    const minute = m[5] ? parseInt(m[5], 10) : 0;
                                                                    const second = m[6] ? parseInt(m[6], 10) : 0;

                                                                    if (
                                                                        month1 < 1 ||
                                                                        month1 > 12 ||
                                                                        day < 1 ||
                                                                        day > 31 ||
                                                                        hour < 0 ||
                                                                        hour > 23 ||
                                                                        minute < 0 ||
                                                                        minute > 59 ||
                                                                        second < 0 ||
                                                                        second > 59
                                                                    )
                                                                        return new Date(NaN);

                                                                    const jdn = jdnFromYMD(year, month1, day);
                                                                    const epochJDN = 2440588;
                                                                    const secondsSinceEpoch =
                                                                        (jdn - epochJDN) * 86400 +
                                                                        (hour * 3600 + minute * 60 + second);
                                                                    const ms = secondsSinceEpoch * 1000;

                                                                    return new Date(ms);
                                                                }

                                                                plot.startDate = parseProlepticDate(model.window.start);
                                                                plot.endDate = parseProlepticDate(model.window.end);

                                                                let xs = model.results.milestones.map((p) => p.x);
                                                                const xMin = Math.min(...xs);
                                                                const xMax = Math.max(...xs);
                                                                plot.grid.zoom(xMin, xMax, 0, 1);
                                                                plot.w = 800;
                                                                plot.h = 400;
                                                                plot.type = 'timeline';
                                                                plot.name = generateNautName();
                                                                plot.x_axis_label = 'Time (Years)';
                                                                plot.y_axis_label = 'Sample Metric';
                                                                plot.fitScaleToData = false;
                                                                plot.grid.rescale();
                                                                await pm.plateTrack.panToNextSpot(800);

                                                                pm.plateTrack.killSprite();
                                                                pm.plateTrack.setPlotCenter(plot);
                                                            } else {
                                                                infoPrompt(' Failed to build the model');
                                                            }
                                                        }, 1000);
                                                    }),
                                                },
                                            ],
                                        },
                                    },
                                },
                            ],
                        ],
                    },
                };
                CurrentLayout.setComponent('mainPanel', sequence_input);
            })
        );

        ai_create_file_items.unshift({
            'label': 'Therapeutic development cost analysis', click: (async () => {
                const plate_graph = pm;
                const pt = pm.plateTrack;
                let sequenceTextEditor;
                let descHook = createIonFunction((p) => {
                    sequenceTextEditor = p;
                });
                const txtOptions = [
                    "Develop a therapeutic targeting a BRCA1 mutation.",
                    "Design a gene therapy for a CFTR mutation.",
                    "Produce an RNA-based drug for a KRAS variant.",
                    "Create a therapy targeting a TP53 mutation.",
                    "Generate an antisense oligonucleotide for an exon-skipping mutation.",
                    "Evaluate a therapeutic candidate for an EGFR mutation.",
                    "Develop a gene-editing therapy for a sickle cell mutation.",
                    "Design an mRNA therapy for a rare genetic disorder.",
                    "Screen an ASO targeting a splice-site mutation.",
                    "Test an RNA therapeutic for an oncogenic mutation.",
                    "Discover a therapy targeting an inherited gene mutation.",
                    "Develop a CRISPR-based treatment for a point mutation.",
                    "Create an mRNA therapeutic for a metabolic gene defect.",
                    "Evaluate a therapy targeting a frameshift mutation.",
                    "Engineer an siRNA therapeutic for a gain-of-function mutation.",
                    "Optimize a gene therapy for a loss-of-function mutation.",
                    "Develop an mRNA therapy for tumor suppressor restoration.",
                    "Advance a candidate targeting a pathogenic variant.",
                    "Generate an siRNA therapy for a dominant-negative mutation.",
                    "Produce an RNA therapy for a genetic disorder.",
                    "Create an antisense drug for mutation correction.",
                    "Design a gene therapy targeting a single-nucleotide variant.",
                    "Develop an siRNA candidate for an oncogenic driver mutation.",
                    "Generate an RNA therapy for a rare mutation.",
                    "Create an ASO targeting a splicing mutation.",
                    "Validate an mRNA therapy for an inherited disease.",
                    "Engineer an siRNA treatment for mutation silencing.",
                    "Discover a therapeutic for a genetic variant.",
                    "Test an RNA molecule targeting a mutation hotspot.",
                    "Develop an mRNA therapy for regenerative gene repair.",
                    "Create an siRNA therapy for a mutated oncogene.",
                    "Design an ASO for mutation-specific targeting.",
                    "Test an RNA therapeutic for variant correction.",
                    "Map a mutation-targeted drug candidate.",
                    "Design a therapeutic for gene mutation repair.",
                    "Validate an siRNA candidate for mutation knockdown.",
                    "Screen an RNA construct for mutation targeting.",
                    "Generate an mRNA therapy for a genetic mutation.",
                    "Optimize an ASO for allele-specific mutation targeting.",
                    "Develop an siRNA therapeutic for variant suppression.",
                    "Evaluate an RNA therapy for mutation correction.",
                    "Produce an mRNA candidate for gene restoration.",
                    "Generate an antisense drug for mutation repair.",
                    "Develop an RNA therapeutic targeting a variant.",
                    "Screen an siRNA construct for mutation silencing.",
                    "Test an mRNA therapy for gene correction.",
                    "Validate an ASO drug for mutation targeting.",
                    "Identify an RNA candidate for variant-specific therapy.",
                    "Create an mRNA therapeutic for a gene mutation.",
                    "Develop an siRNA construct for mutation knockdown.",
                    "Produce an antisense molecule for variant correction.",
                    "Test an RNA therapeutic for mutation repair.",
                    "Evaluate an siRNA construct for mutation targeting.",
                    "Build an mRNA therapeutic for a gene defect.",
                    "Test an mRNA drug candidate for mutation correction.",
                    "Focus on an antisense molecule for variant targeting.",
                    "Validate an siRNA therapeutic for mutation silencing.",
                    "Produce an RNA interference molecule for a mutation.",
                    "Design an mRNA candidate for a genetic disorder.",
                    "Test an ASO for mutation-specific targeting.",
                    "Generate an siRNA therapy for a gene variant.",
                    "Produce an RNAi candidate for mutation suppression.",
                    "Develop an antisense oligonucleotide for a mutation.",
                    "Test an mRNA candidate for gene correction.",
                    "Evaluate an siRNA construct for variant targeting.",
                    "Build an antisense oligonucleotide for mutation repair.",
                    "Create an RNAi therapy for a genetic mutation.",
                    "Develop an mRNA therapeutic for variant correction.",
                    "Screen an siRNA molecule for mutation knockdown.",
                    "Create an antisense therapeutic for a gene mutation.",
                    "Design an RNAi therapeutic for mutation silencing.",
                    "Test an mRNA drug candidate for variant repair.",
                    "Focus on an antisense molecule for a gene variant.",
                    "Validate an siRNA therapeutic for mutation targeting.",
                    "Produce an RNAi molecule for mutation suppression.",
                    "Design an antisense drug for a genetic mutation."
                ];

                const txt = txtOptions[Math.floor(Math.random() * txtOptions.length)]; let initalText = true;
                setTimeout(() => {
                    let i = 0;
                    let currentText = '';

                    const interval = setInterval(() => {

                        currentText += txt[i];
                        if (!initalText) {
                            sequenceTextEditor.setContent('');
                            clearInterval(interval)
                            return;
                        }
                        sequenceTextEditor.setContent(currentText);
                        i++;

                        if (i >= txt.length) {
                            clearInterval(interval);
                        }
                    }, 10);
                }, 450);
                let sequence_input = {
                    wid: 'card',
                    "height": "200px",
                    data: {
                        "style.padding-top": '1px',
                        "style.border": '1px',
                        'style.height': '200px',
                        cards: [
                            [
                                {
                                    'width': '100%',
                                    'component': {
                                        wid: 'html',
                                        data: `
                                                    <H4>
                                                    <font color="navy">
                                                    Describe the model you want to create below:
                                                    </font> </h4>
                                                    `
                                    }

                                },
                                {
                                    'width': '100%',
                                    'component': {
                                        wid: 'text-editor',
                                        refCallback: descHook,
                                        data: {
                                            height: "600px",
                                            showButton: false,
                                            editorOptions: {
                                                value: '',
                                                language: 'text', automaticLayout: true, fontSize: 24, lineNumbers: "off",
                                                suggestOnTriggerCharacters: false,
                                                quickSuggestions: false,
                                                parameterHints: { enabled: false },
                                                minimap: { enabled: false },
                                                fontFamily: "Courier New, monospace",
                                                placeholder: "Enter a paragraph that describes the timeline you want to create.  For example:  I want to create a timeline that describes important milestones about Vasco De Gamma around the Cape of Good Hope",
                                                cursorStyle: "block"
                                            },
                                            onDidFocusEditorWidget: createIon(() => {
                                                if (initalText)
                                                    sequenceTextEditor.setContent("")
                                                initalText = false;
                                            }),

                                            keybinding: {
                                                'Ctrl+Enter': createIonFunction((content, lineNumber, col) => {
                                                })
                                            },
                                        }
                                    }
                                },
                                {
                                    'width': '100%',
                                    'component': {
                                        wid: 'html',
                                        data: '<hr>'
                                    }
                                },
                                {
                                    'component': {
                                        wid: 'mt-button', data: {
                                            buttons: [
                                                {
                                                    label: 'Cancel', ionFunction: createIonFunction(async () => {
                                                        hideAllModal();
                                                        CurrentLayout.reset('mainPanel')

                                                    })
                                                },
                                                {
                                                    label: 'Build', ionFunction: createIonFunction(async () => {
                                                        hideAllModal();
                                                        CurrentLayout.reset('mainPanel')
                                                        let em = new EngineMonitor((msg) => {
                                                            plate_graph.plateTrack.updateSprite(msg)
                                                        });
                                                        em.addProgressListener(async (v) => {
                                                            if (v >= 100) {
                                                            }
                                                        })
                                                        let content = sequenceTextEditor.getContent();
                                                        const user_prompt = content;
                                                        plate_graph.plateTrack.setMessage("Generating Assumptions...", 5)
                                                        let model = await exec('py/openai/assumptions-create-therapy.py', em, getUser(), content);
                                                        exec('ljl/draw/data-model-to-tables-gpt', plate_graph.plateTrack, model).then(async r => {
                                                            plate_graph.plateTrack.setMessage(null)
                                                            plate_graph.plateTrack.setMessage("These are the Assumptions! You will edit these.", 1)
                                                            setTimeout(() => {
                                                                plate_graph.plateTrack.killSprite()
                                                                let pr = []
                                                                let formula = []
                                                                for (let p of plate_graph.plateTrack.root) {
                                                                    pr.push(p.toValueFormulaJSON())
                                                                    formula.push({ 'Table': p.name, 'HAS these assignments': p.getFormula() })
                                                                }
                                                                let g = CurrentLayout.getStashed('graph')
                                                                if (g)
                                                                    g.touchMe();
                                                                pt.updateCalculations();
                                                                setTimeout(async () => {
                                                                    let t = plate_graph.plateTrack.getTableByName('Assumptions')
                                                                    plate_graph.plateTrack.setMessage('PnL', 5)
                                                                    let ts = (t.toValueFormulaJSON())
                                                                    let pnl = await exec('py/openai/create-therapy.py', user_prompt, ts)
                                                                    let r = await exec('ljl/draw/data-model-to-tables-gpt', plate_graph.plateTrack, pnl)
                                                                    plate_graph.plateTrack.setMessage("Budget ---formulas that use the assumptions", 1)
                                                                    setTimeout(async () => {
                                                                        let pr = []
                                                                        let formula = []
                                                                        for (let p of plate_graph.plateTrack.root) {
                                                                            pr.push(p.toValueFormulaJSON())
                                                                            formula.push({ 'Table': p.name, 'HAS these assignments': p.getFormula() })
                                                                        }
                                                                        let g = CurrentLayout.getStashed('graph')
                                                                        if (g)
                                                                            g.touchMe();
                                                                        let items = []
                                                                        plate_graph.plateTrack.updateCalculations();

                                                                        setTimeout(async () => {
                                                                            let ls = [
                                                                            ]
                                                                            for (let p of plate_graph.plateTrack.root) {
                                                                                ls.push(p.toValueFormulaJSON())
                                                                            }
                                                                            let g = CurrentLayout.getStashed('graph')
                                                                            if (g)
                                                                                g.touchMe();
                                                                            pt.killSprite();
                                                                            plate_graph.plateTrack.updateCalculations();
                                                                            pt.layoutCompactTetris();
                                                                            pt.zoomouttoFit();

                                                                            for (let p of plate_graph.plateTrack.root) {
                                                                                ls.push(p.toValueFormulaJSON())
                                                                            }
                                                                            for (let p of plate_graph.plateTrack.root) {
                                                                                p.selectWellsByString('[1:][1:]')
                                                                                const se = p.getSelectedWellsInOrder();
                                                                                for (let w of se) {
                                                                                    items.push({
                                                                                        id: w.uid,
                                                                                        value: w.value,
                                                                                        fields: Object.keys(w.group),
                                                                                        wtype: ''
                                                                                    })
                                                                                }
                                                                            }

                                                                            setTimeout(async () => {
                                                                                plate_graph.plateTrack.killSprite()

                                                                                let assumptions = plate_graph.plateTrack.getTableByName('Assumptions')
                                                                                let pnl = plate_graph.plateTrack.getTableByName('Analysis')

                                                                                let model = await exec('py/openai/create-therapy-timeline.py', em, assumptions, pnl)

                                                                                let MPlot = await exec('flexigraph/plot.js')
                                                                                const plot = new MPlot({ points: model.intervals });
                                                                                plot.startDate = new Date(model.window.start);
                                                                                plot.endDate = new Date(model.window.end);
                                                                                const xMin = Math.min(...model.intervals.map(p => p.startX));
                                                                                const xMax = Math.max(...model.intervals.map(p => p.x));
                                                                                plot.grid.zoom(xMin, xMax, 0, 1);
                                                                                plot.w = 1800;
                                                                                plot.h = 500;
                                                                                plot.type = 'timeline'
                                                                                plot.name = 'test-timeline';
                                                                                plot.x_axis_label = "Time (Years)";
                                                                                plot.y_axis_label = "Sample Metric";
                                                                                plot.fitScaleToData = false;
                                                                                plot.grid.rescale();
                                                                                pm.plateTrack.setPlotCenter(plot)
                                                                                pt.killSprite();

                                                                                setTimeout(() => {
                                                                                    pt.layoutCompactTetris();
                                                                                    pm.plateTrack.deselectAll();
                                                                                }, 100)

                                                                            }, 200)

                                                                        }, 400)
                                                                    }, 100)
                                                                    plate_graph.plateTrack.___formula_integrity_report = pnl;
                                                                }, 1000)
                                                            }, 3000)
                                                            plate_graph.plateTrack.___formula_integrity_report = model;
                                                        })
                                                    })
                                                }

                                            ]

                                        }
                                    }
                                }
                            ]]
                    }
                }

                CurrentLayout.setComponent('mainPanel', sequence_input)

            })
        })

        ai_create_file_items.unshift({
            'label': 'La Jolla Labs Screening', click: (async () => {
                const plate_graph = pm;
                const pt = pm.plateTrack;
                let sequenceTextEditor;
                let descHook = createIonFunction((p) => {
                    sequenceTextEditor = p;
                });

                const txtOptions = [
                    "Develop 10 gapmer ASOs.",
                    "Design 5 siRNA candidates.",
                    "Produce 12 RNAi therapeutics.",
                    "Create 6 mRNA-based therapies.",
                    "Generate 8 steric-blocking ASOs.",
                    "Evaluate 15 siRNA constructs.",
                    "Develop 10 RNAi therapies.",
                    "Design 7 mRNA vaccine candidates.",
                    "Screen 6 gapmer ASOs.",
                    "Test 10 siRNA molecules.",
                    "Discover 8 ASO therapies.",
                    "Develop 12 RNAi drug candidates.",
                    "Create 5 mRNA-based treatments.",
                    "Evaluate 10 steric-blocking ASOs.",
                    "Engineer 6 siRNA therapeutics.",
                    "Optimize 10 RNAi therapies.",
                    "Develop 7 mRNA vaccines.",
                    "Advance 12 gapmer ASO candidates.",
                    "Generate 5 siRNA therapeutics.",
                    "Produce 10 RNAi therapies.",
                    "Create 9 antisense oligonucleotides.",
                    "Design 10 mRNA therapeutics.",
                    "Develop 7 siRNA candidates.",
                    "Generate 6 RNAi therapeutics.",
                    "Create 10 steric-blocking ASOs.",
                    "Validate 12 mRNA vaccines.",
                    "Engineer 5 siRNA treatments.",
                    "Discover 8 antisense therapeutics.",
                    "Test 10 RNAi molecules.",
                    "Develop 7 mRNA regenerative therapies.",
                    "Create 11 siRNA therapies.",
                    "Design 9 gapmer ASOs.",
                    "Test 10 RNAi therapeutics.",
                    "Map 6 mRNA drugs.",
                    "Design 10 antisense therapeutics.",
                    "Validate 5 siRNA candidates.",
                    "Screen 15 RNAi constructs.",
                    "Generate 7 mRNA vaccines.",
                    "Optimize 10 gapmer ASOs.",
                    "Develop 12 siRNA therapeutics.",
                    "Evaluate 8 RNAi therapies.",
                    "Produce 10 mRNA candidates.",
                    "Generate 7 antisense drugs.",
                    "Develop 10 RNAi therapeutics.",
                    "Screen 12 siRNA constructs.",
                    "Test 6 mRNA therapies.",
                    "Validate 10 ASO drugs.",
                    "Identify 8 RNAi candidates.",
                    "Create 10 mRNA therapeutics.",
                    "Develop 12 siRNA constructs.",
                    "Produce 7 antisense molecules.",
                    "Test 10 RNAi therapeutics.",
                    "Evaluate 15 siRNA constructs.",
                    "Build 6 mRNA therapeutics.",
                    "Test 10 mRNA drug candidates.",
                    "Focus on 8 antisense molecules.",
                    "Validate 7 siRNA therapeutics.",
                    "Produce 10 RNA interference molecules.",
                    "Design 15 mRNA candidates.",
                    "Test 10 gapmer ASOs.",
                    "Generate 8 siRNA therapies.",
                    "Produce 12 RNAi candidates.",
                    "Develop 10 antisense oligonucleotides.",
                    "Test 8 mRNA candidates.",
                    "Evaluate 15 siRNA constructs.",
                    "Build 6 antisense oligonucleotides.",
                    "Create 12 RNAi therapies.",
                    "Develop 7 mRNA therapeutics.",
                    "Screen 9 siRNA molecules.",
                    "Create 10 antisense therapeutics.",
                    "Design 12 RNAi therapeutics.",
                    "Test 10 mRNA drug candidates.",
                    "Focus on 8 antisense molecules.",
                    "Validate 7 siRNA therapeutics.",
                    "Produce 10 RNAi molecules.",
                    "Design 11 antisense drugs."
                ];

                const txt = txtOptions[Math.floor(Math.random() * txtOptions.length)];
                let initalText = true;
                setTimeout(() => {
                    let i = 0;
                    let currentText = '';

                    const interval = setInterval(() => {
                        currentText += txt[i];
                        if (!initalText) {
                            sequenceTextEditor.setContent('');
                            clearInterval(interval)
                            return;
                        }
                        sequenceTextEditor.setContent(currentText);
                        i++;

                        if (i >= txt.length) {
                            clearInterval(interval);
                        }
                    }, 10);
                }, 500);
                let sequence_input = {
                    wid: 'card',
                    "height": "200px",
                    data: {
                        "style.padding-top": '1px',
                        "style.border": '1px',
                        'style.height': '200px',
                        cards: [
                            [
                                {
                                    'width': '100%',
                                    'component': {
                                        wid: 'html',
                                        data: `

                                                                    <H4>
                    <font color="navy">

                                                                    Describe your project:

                                                                    </font> </h4>
                                                                    Click in the text box below to start.
                                                                    `
                                    }

                                },
                                {
                                    'width': '100%',
                                    'component': {
                                        wid: 'text-editor',
                                        refCallback: descHook,
                                        data: {
                                            height: "300px",
                                            showButton: false,
                                            editorOptions: {
                                                value: '',
                                                language: 'text', automaticLayout: true, fontSize: 24, lineNumbers: "off",
                                                suggestOnTriggerCharacters: false,
                                                quickSuggestions: false,
                                                parameterHints: { enabled: false },
                                                minimap: { enabled: false },
                                                fontFamily: "Courier New, monospace",
                                                placeholder: "Enter a paragraph that describes the timeline you want to create.  For example:  I want to create a timeline that describes important milestones about Vasco De Gamma around the Cape of Good Hope",
                                                cursorStyle: "block"
                                            },
                                            onDidFocusEditorWidget: createIon(() => {
                                                if (initalText)
                                                    sequenceTextEditor.setContent("")
                                                initalText = false;
                                            }),

                                            keybinding: {
                                                'Ctrl+Enter': createIonFunction((content, lineNumber, col) => {
                                                })
                                            },
                                        }
                                    }
                                },
                                {
                                    'width': '100%',
                                    'component': {
                                        wid: 'html',
                                        data: '<hr>'
                                    }
                                },
                                {
                                    'component': {
                                        wid: 'mt-button', data: {
                                            buttons: [
                                                {
                                                    label: 'Cancel', ionFunction: createIonFunction(async () => {
                                                        hideAllModal();
                                                        CurrentLayout.reset('mainPanel')

                                                    })
                                                },
                                                {
                                                    label: 'Build', ionFunction: createIonFunction(async () => {

                                                        hideAllModal();
                                                        CurrentLayout.reset('mainPanel')

                                                        let interval = null;
                                                        let em = new EngineMonitor((msg) => {
                                                            plate_graph.plateTrack.updateSprite(msg)
                                                        });
                                                        em.addProgressListener(async (v) => {
                                                            if (v >= 100) {
                                                            }
                                                        })
                                                        let content = sequenceTextEditor.getContent();
                                                        const user_prompt = content;
                                                        plate_graph.plateTrack.setMessage("Generating Assumptions...", 5)
                                                        let model = await exec('py/openai/assumptions-ljl-screening.py', em, content)
                                                        exec('ljl/draw/data-model-to-tables-gpt', plate_graph.plateTrack, model).then(async r => {
                                                            plate_graph.plateTrack.setMessage(null)
                                                            plate_graph.plateTrack.setMessage("These are the Assumptions! You will edit these.", 1)
                                                            setTimeout(() => {
                                                                plate_graph.plateTrack.killSprite()
                                                                let pr = []
                                                                let formula = []
                                                                for (let p of plate_graph.plateTrack.root) {
                                                                    pr.push(p.toValueFormulaJSON())
                                                                    formula.push({ 'Table': p.name, 'HAS these assignments': p.getFormula() })
                                                                }

                                                                let g = CurrentLayout.getStashed('graph')
                                                                if (g)
                                                                    g.touchMe();

                                                                pt.updateCalculations();
                                                                setTimeout(async () => {
                                                                    let t = plate_graph.plateTrack.getTableByName('LJL_InVitro_Screen_Assumptions')
                                                                    plate_graph.plateTrack.setMessage('PnL', 5)
                                                                    let ts = (t.toValueFormulaJSON())
                                                                    let pnl = await exec('py/openai/budget-for-ljl-screen.py', user_prompt, ts)
                                                                    let r = await exec('ljl/draw/data-model-to-tables-gpt', plate_graph.plateTrack, pnl)
                                                                    plate_graph.plateTrack.setMessage("Formulas added ---formulas that use the assumptions", 1)

                                                                    setTimeout(async () => {
                                                                        let pr = []
                                                                        let formula = []
                                                                        for (let p of plate_graph.plateTrack.root) {
                                                                            pr.push(p.toValueFormulaJSON())
                                                                            formula.push({ 'Table': p.name, 'HAS these assignments': p.getFormula() })
                                                                        }
                                                                        let g = CurrentLayout.getStashed('graph')
                                                                        if (g)
                                                                            g.touchMe();
                                                                        let items = []
                                                                        plate_graph.plateTrack.updateCalculations();
                                                                        setTimeout(async () => {
                                                                            let ls = [
                                                                            ]
                                                                            for (let p of plate_graph.plateTrack.root) {
                                                                                ls.push(p.toValueFormulaJSON())
                                                                            }

                                                                            let g = CurrentLayout.getStashed('graph')
                                                                            if (g)
                                                                                g.touchMe();

                                                                            pt.layoutCompactTetris();
                                                                            pt.killSprite();
                                                                            pt.zoomouttoFit();
                                                                            pt.layoutCompactTetris();

                                                                            plate_graph.plateTrack.updateCalculations();
                                                                            for (let p of plate_graph.plateTrack.root) {
                                                                                ls.push(p.toValueFormulaJSON())
                                                                            }

                                                                            for (let p of plate_graph.plateTrack.root) {
                                                                                p.selectWellsByString('[1:][1:]')
                                                                                const se = p.getSelectedWellsInOrder();
                                                                                for (let w of se) {
                                                                                    items.push({
                                                                                        id: w.uid,
                                                                                        value: w.value,
                                                                                        fields: Object.keys(w.group),
                                                                                        wtype: ''
                                                                                    })
                                                                                }
                                                                            }

                                                                            setTimeout(async () => {
                                                                                let ls = [
                                                                                ]
                                                                                for (let p of plate_graph.plateTrack.root) {
                                                                                    ls.push(p.toValueFormulaJSON())
                                                                                }
                                                                                let g = CurrentLayout.getStashed('graph')
                                                                                if (g)
                                                                                    g.touchMe();
                                                                                pt.layoutCompactTetris();
                                                                                pm.plateTrack.setMessage("Building timeline", 5)
                                                                                let user_prompt = sequenceTextEditor.getContent();
                                                                                let prpt = await exec('py/openai/generate-prmpt.py', em, user_prompt, ls)
                                                                                if (prpt.steps) {
                                                                                    let cs = []
                                                                                    let index = 0;
                                                                                    for (let plp of prpt.steps) {
                                                                                        cs[index++] = plp.replace(/[^\w\s]|_/g, "").replace(/\s+/g, " ");
                                                                                    }
                                                                                    let p = cs.join('\n')
                                                                                    let model = await exec('py/openai/timeline.py', em, p)
                                                                                    pm.plateTrack.killSprite()
                                                                                    const plot = await exec('flexigraph/gantt-factory', model)
                                                                                    plot.isBackground = true;
                                                                                    pm.plateTrack.setPlotCenter(plot)
                                                                                }
                                                                                plate_graph.plateTrack.updateCalculations();
                                                                                pt.killSprite();
                                                                                setTimeout(() => {
                                                                                    pt.layoutCompactTetris();
                                                                                }, 1000)
                                                                            }, 1000)

                                                                        }, 400)
                                                                    }, 100)
                                                                    plate_graph.plateTrack.___formula_integrity_report = pnl;
                                                                }, 1000)
                                                            }, 3000)
                                                            plate_graph.plateTrack.___formula_integrity_report = model;
                                                        })
                                                    })
                                                }

                                            ]

                                        }
                                    }
                                }
                            ]]
                    }
                }
                CurrentLayout.setComponent('mainPanel', sequence_input)

            })
        })

        ai_create_file_items.push({
            'label': 'Precision Therapeutics Designer', click: (async () => {
                const MSGraph = await exec('lib/msgraph.js');

                if (!MSGraph.isLoggedIn()) {
                    login();

                } else {

                    clear();
                    const path = '/'
                    window.history.pushState({ 'rna-screen': path }, 'yak', `/app/screen/editor`);
                    exec('screen/editor', path, { mode: 'editor' })

                }
            })
        })

        ai_create_file_items.push({
            'label': 'Precision Therapeutics Analysis', click: (async () => {
                clear();
                const path = '/'
                await exec('cpd/ptx-analytics')
                window.history.pushState({ 'rna-screen': path }, 'yak', `app/cpd/ptx-analytics`);


                

            })
        })

        return resolve(ai_create_file_items);

    })

}
