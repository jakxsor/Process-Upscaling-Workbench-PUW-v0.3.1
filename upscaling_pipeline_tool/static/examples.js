(function (root) {
  const octocryleneExampleBasis = (() => {
    const productKg = 1;
    const productMw = 361.48;
    const endpointConversionPercent = 99.5;
    const reactedMol = productKg * 1000 / productMw;
    const chargedMol = reactedMol / (endpointConversionPercent / 100);
    // Four significant figures: the charges are back-calculated from a 1 kg basis and a 99.5%
    // endpoint proxy, so "0.50662742 kg" claimed eight digits the SI never had.
    const mass = (mol, mw) => String(Number((mol * mw / 1000).toPrecision(4)));
    const cyclohexaneChargeL = 2.5;
    const solventRecoveryTarget = 0.98;
    const reactionWaterKg = mass(reactedMol, 18.015);
    const washWaterL = 2.0;
    // Auxiliaries the SI names but does not quantify. Each is an engineering estimate with the
    // method recorded on its stream note; they are
    // entered so the unit balances close and the vents and wastewater carry a number, and they
    // stay labelled "estimated" until the authors replace them from the notebook.
    // NH4OAc: 20 mol% on the cyanoacetate, the textbook Knoevenagel loading (range 10-50 mol%).
    const catalystLoadingMolPercent = 20;
    const catalystKg = String(Number((chargedMol * catalystLoadingMolPercent / 100 * 77.08 / 1000).toPrecision(2)));
    // Ethyl acetate extraction: one volume of the reaction mixture is laboratory practice; kept as a
    // placeholder because the SI requires the extraction (at plant scale it is redundant and forms an
    // azeotrope with cyclohexane, so it is flagged rather than dropped).
    const ethylAcetateL = 1.0;
    // Brine wash: one volume equal to the water wash; saturated NaCl 26.4 wt%, 1200 kg/m3 at 25 degC.
    const brineL = 1.0;
    const brineKg = brineL * 1.2;
    // Cyclohexane vent losses from vapour-liquid equilibrium: 0.5 m3/h N2 sweep for 20 h at a 10 degC
    // condenser outlet (Pvap 6.3 kPa, y = 0.062) gives 2.4 kg per 3000 kg batch for the reactor;
    // the evaporator vacuum-pump exhaust is an order-of-magnitude allowance. 90% capture in U7.
    const reactorVentCyclohexaneKg = 0.0008;
    const evaporatorVentCyclohexaneKg = 0.0001;
    const ventCaptureFraction = 0.9;
    const ventInKg = reactorVentCyclohexaneKg + evaporatorVentCyclohexaneKg;
    // Cyclohexane dissolved in the Dean-Stark water (55 mg/L at 25 degC in 0.050 kg water): 3 mg.
    const deanStarkPurgeCyclohexaneKg = 0.00001;
    // Water removed by the 4A bed: dissolved (3.3 wt% in EtOAc, 0.01 wt% in cyclohexane) plus
    // 0.1-0.5 wt% entrained after the decanter, minus the 500 ppm left in the product.
    const sieveRegenerationWaterKg = 0.040;
    const wastewaterKg = Number(reactionWaterKg) + washWaterL * 0.997 + Number(catalystKg) + brineKg + sieveRegenerationWaterKg;
    // Distillation residue: the SI reports a still-bottoms heavy fraction (self-condensation and
    // Michael adducts of the Knoevenagel reaction) with neither quantity nor composition. Entered
    // at 3 wt% of the crude (mid-point of the 2-5 wt% typical for this chemistry, chosen by the
    // authors), where "crude" is approximated as the product plus the unreacted reagents it forms
    // alongside, since the residue itself is a second-order correction to that mass. Formed in the
    // reactor and carried unchanged through extraction, drying and evaporation like the other
    // non-volatile components, so it closes the ninth and last open unit balance (G6).
    const unreactedBenzophenoneKg = mass(chargedMol - reactedMol, 182.22);
    const unreactedCyanoacetateKg = mass(chargedMol - reactedMol, 197.28);
    const distillationResiduePercent = 3;
    const distillationResidueKg = (productKg + Number(unreactedBenzophenoneKg) + Number(unreactedCyanoacetateKg)) * distillationResiduePercent / 100;
    return Object.freeze({
      productKg: String(productKg),
      productMw: String(productMw),
      endpointConversionPercent: String(endpointConversionPercent),
      benzophenoneKg: mass(chargedMol, 182.22),
      cyanoacetateKg: mass(chargedMol, 197.28),
      unreactedBenzophenoneKg,
      unreactedCyanoacetateKg,
      reactionWaterKg,
      washWaterL: washWaterL.toFixed(1),
      cyclohexaneChargeL: String(cyclohexaneChargeL),
      cyclohexaneRecoveredL: (cyclohexaneChargeL * solventRecoveryTarget).toFixed(2),
      cyclohexaneMakeupL: (cyclohexaneChargeL * (1 - solventRecoveryTarget)).toFixed(2),
      solventRecoveryPercent: String(solventRecoveryTarget * 100),
      catalystLoadingMolPercent: String(catalystLoadingMolPercent),
      catalystKg,
      ethylAcetateL: ethylAcetateL.toFixed(1),
      brineL: brineL.toFixed(1),
      brineKg: brineKg.toFixed(2),
      reactorVentCyclohexaneKg: String(reactorVentCyclohexaneKg),
      evaporatorVentCyclohexaneKg: String(evaporatorVentCyclohexaneKg),
      ventInKg: String(Number(ventInKg.toPrecision(1))),
      ventRecoveredKg: String(Number((ventInKg * ventCaptureFraction).toPrecision(1))),
      ventEmittedKg: String(Number((ventInKg * (1 - ventCaptureFraction)).toPrecision(1))),
      ventCapturePercent: String(ventCaptureFraction * 100),
      deanStarkPurgeCyclohexaneKg: String(deanStarkPurgeCyclohexaneKg),
      sieveRegenerationWaterKg: sieveRegenerationWaterKg.toFixed(3),
      wastewaterKg: String(Number(wastewaterKg.toPrecision(3))),
      distillationResiduePercent: String(distillationResiduePercent),
      distillationResidueKg: String(Number(distillationResidueKg.toPrecision(2)))
    });
  })();

  // Readability-normalized cyclohexane route from SI Table S1. Calculated charges and industrial
  // equipment choices stay in the MFA and scale-up layers instead of being presented as protocol facts.
  const octocryleneExampleSteps = Object.freeze({
    B1: "Equip a four-necked round-bottom flask with a mechanical stirrer, thermometer, reflux condenser, and Dean-Stark trap. Under a nitrogen blanket at 25 °C, charge benzophenone, 2-ethylhexyl cyanoacetate, ammonium acetate, and cyclohexane (2.5 L per kg of target product), then begin stirring.",
    B2: "Heat the stirred suspension to cyclohexane reflux at 85-90 °C over 0.5-1 h. Continue until the benzophenone has dissolved and stable reflux is established.",
    B3: "Maintain reflux at 85-90 °C for 18-24 h under nitrogen. Continuously collect the reaction water in the Dean-Stark trap and return the cyclohexane phase to the flask. End the reaction when water collection ceases and residual benzophenone is below 0.5%.",
    B4: "Cool the reaction mixture to 25 °C over approximately 1 h.",
    B5: "Extract the crude mixture with ethyl acetate. Wash the organic phase with water (2 L per kg of target product), allow the phases to separate, and remove the aqueous phase.",
    B6: "Wash the retained organic phase with saturated sodium chloride solution. Allow the phases to separate, then remove the aqueous brine phase.",
    B7: "Dry the organic phase over anhydrous magnesium sulfate or sodium sulfate until the water content is below 500 ppm, then filter off the drying agent.",
    B8: "Concentrate the filtrate under reduced pressure to remove cyclohexane and residual ethyl acetate.",
    B9: "Purify the crude octocrylene by vacuum distillation at approximately 1.5 mmHg and a head temperature of approximately 210 °C. Collect the light-yellow, viscous product fraction.",
    B10: "[Industrial addition] Route cyclohexane-rich vents from the reactor and evaporator to a condenser and activated-carbon polishing system.",
    B11: "[Industrial addition] Combine the cyclohexane recovery feeds in a dedicated distillation column, target at least 98 percent recovery, and return purified cyclohexane to feed preparation.",
    B12: "[Industrial addition] Route reaction water, aqueous wash, brine, and molecular-sieve regeneration water to the wastewater-treatment interface."
  });
  const sampleText = Object.entries(octocryleneExampleSteps)
    .filter(([id]) => Number(id.slice(1)) <= 9)
    .map(([, text]) => text)
    .join("\n\n");

  // Biodiesel by base-catalysed transesterification of a vegetable oil (triolein basis). The
  // procedure and its numbers are the textbook ones: 6:1 methanol-to-oil molar ratio, 1 wt% NaOH
  // on oil, 60 degC, 1 h (Freedman, Pryde and Mounts, J. Am. Oil Chem. Soc. 61 (1984) 1638;
  // Van Gerpen, Fuel Processing Technology 86 (2005) 1097); product quality per EN 14214.
  const biodieselExampleSteps = Object.freeze({
    B1: "Dissolve 10 g of sodium hydroxide in 217 g of methanol (6:1 molar ratio of methanol to oil) with stirring at 25 °C to prepare the sodium methoxide solution.",
    B2: "Charge 1.00 kg of refined vegetable oil (triolein basis, 1.13 mol) to a jacketed stirred reactor and heat to 60 °C. Add the methoxide solution and stir at 600 rpm for 1 h at 60 °C and atmospheric pressure.",
    B3: "Stop stirring and transfer the mixture to a separating vessel. Allow the phases to settle for 1.5 h at 50 °C and draw off the lower glycerol-rich phase.",
    B4: "Recover the excess methanol from the ester phase by distillation at 65-70 °C under reduced pressure (200 mbar).",
    B5: "Wash the ester phase three times with 0.3 L of warm water at 50 °C, settling for 0.5 h after each wash and discarding the aqueous phase.",
    B6: "Dry the washed ester under vacuum (50 mbar) at 105 °C for 0.5 h until the water content is below 500 mg/kg.",
    B7: "Filter the dried methyl ester through a 5 µm filter and collect the biodiesel product (ester content at least 96.5 percent by mass, EN 14214).",
    B8: "[Industrial addition] Recover methanol from the glycerol-rich phase in a dedicated column and return it to methoxide preparation.",
    B9: "[Industrial addition] Neutralize the crude glycerol phase for valorization and route wash water and drying condensate to the wastewater-treatment interface.",
    // Reaction-only variant: the reactor sentence ends with the effluent to be separated, so the
    // protocol stops where the screening starts.
    B2r: "Charge 1.00 kg of refined vegetable oil (triolein basis, 1.13 mol) to a jacketed stirred reactor and heat to 60 °C. Add the methoxide solution and stir at 600 rpm for 1 h at 60 °C and atmospheric pressure. The effluent contains methyl oleate, glycerol, excess methanol, unconverted glycerides and the dissolved catalyst; recover the ester at EN 14214 quality, the glycerol as a co-product and the methanol for recycle."
  });
  const biodieselSampleText = Object.entries(biodieselExampleSteps)
    .filter(([id]) => /^B\d+$/.test(id) && Number(id.slice(1)) <= 7)
    .map(([, text]) => text)
    .join("\n\n");
  const biodieselReactionOnlyText = [biodieselExampleSteps.B1, biodieselExampleSteps.B2r].join("\n\n");

  // Published sources behind the quantities that the protocols do not report. Kept in one place so
  // a row cites the same wording wherever it is rendered and a correction lands once. Two families:
  // the regulatory/engineering methods that CALCULATE a loss, and the LCI conventions that say what
  // to ASSUME when it cannot be calculated. Each string is what the user sees on hover.
  const citations = Object.freeze({
    freedman1984: "Freedman, Pryde & Mounts, Variables affecting the yields of fatty esters from transesterified vegetable oils, J. Am. Oil Chem. Soc. 61(10):1638-1643 (1984), doi:10.1007/BF02541649: 6:1 methanol-to-oil molar ratio, 1 wt% NaOH on oil, 60 degC, 1 h.",
    vanGerpen2005: "Van Gerpen, Biodiesel processing and production, Fuel Process. Technol. 86(10):1097-1107 (2005), doi:10.1016/j.fuproc.2004.11.005: alkali-catalysed process, glycerol settling, methanol recovery and water washing of the ester phase.",
    en14214: "EN 14214:2012+A2:2019, Liquid petroleum products - Fatty acid methyl esters (FAME) for use in diesel engines and heating applications - Requirements and test methods, Table 1: ester content >= 96.5 % m/m, water <= 500 mg/kg, methanol <= 0.20 % m/m, triglyceride <= 0.20 % m/m, total glycerol <= 0.25 % m/m.",
    biodieselLiterature: "Reaction conditions and charges from Freedman et al. 1984 and Van Gerpen 2005 (see citations.freedman1984, citations.vanGerpen2005); product limits per EN 14214.",
    biodieselDerived: "Stoichiometric and mass-balance arithmetic on the literature charges (6:1 methanol-to-oil, 1 wt% NaOH, 97.5 % conversion; citations.freedman1984) on a 1 kg triolein basis; four significant figures.",
    biodieselEstimate: "No published figure for this step on this basis: a typical engineering value for alkali-catalysed biodiesel plants, entered so the balance closes. Replace with plant or pilot data before design use.",
    cfrPurge: "40 CFR 63.1257(d)(2)(i)(B), Eq. 12 (filled-vessel purging); derivation in US EPA, Control of VOC Emissions from Batch Processes, EPA-453/R-93-017 (1994), s. 3.1.2.2. EPA guidance: assume the vent is fully saturated for an agitated vessel.",
    cfrVacuum: "40 CFR 63.1257(d)(2)(i)(E), Eq. 33 (vacuum systems); air in-leakage correlations and the VOC load in EPA-453/R-93-017 (1994), s. 3.1.8.1, Eq. 3-25 to 3-32, tracing to Ryans & Croll, Chem. Eng. 88:78 (1981).",
    cfrDrying: "40 CFR 63.1257(d)(2)(i)(G), Eq. 35 (air drying); EPA-453/R-93-017 (1994), s. 3.1.1.",
    eiip16: "US EPA, Methods for Estimating Air Emissions from Chemical Manufacturing Facilities, EIIP Vol. II ch. 16 (Aug 2007): consolidated implementation of the batch emission models.",
    ecoinventGapFill: "Hischier, Hellweg, Capello & Primas, Int. J. Life Cycle Assess. 10(1):59-67 (2005), doi:10.1065/lca2004.10.181.7. The standing ecoinvent gap-filling rule: where emissions are unreported, assume 0.2% of input mass to air and the remainder to water.",
    geislerDefaults: "Geisler, Hofstetter & Hungerbuhler, Int. J. Life Cycle Assess. 9(2):101-113 (2004), doi:10.1007/BF02978569, Table 2. Fine-chemical batch defaults chosen to bracket 90% of real cases: solvent charge 0.2-4 kg/kg product, solvent recycle factor 0.95 best case to 0 worst case, air emission factor 1e-7 to 1e-3 of process mass.",
    iedSolvent: "Directive 2010/75/EU (Industrial Emissions Directive), Annex VII Part 2 row 20: fugitive solvent emissions from pharmaceutical manufacture are capped at 5% of solvent input for new installations and 15% for existing ones. Annex VII Part 7 defines the O1-O9 solvent-management-plan compartments.",
    octocrylenePatent: "US 2010/0048937 A1 (WO 2008/089920 A1, EP 2125707 B1), Process for the manufacture of substituted 2-cyano cinnamic esters. Claims a C3-C6 monocarboxylic acid plus an ammonium compound, ammonium:ketone 0.7-1.2 mol/mol, water removed azeotropically with cyclohexane or heptane.",
    sccsOctocrylene: "SCCS/1627/21, Final Opinion on Octocrylene, s. 3.1.8: mp -10 degC, bp 218 degC at 1.5 mmHg with decomposition above 300 degC, vapour pressure 0 Pa at 25 degC, density 1.051 g/cm3.",
    cyclohexaneWater: "IUPAC-NIST Solubility Data Series, cyclohexane + water; Gregory, Christian & Affsprung, J. Phys. Chem. 71:2283-9 (1967): water in cyclohexane 0.0069 wt% at 25 degC.",
    knoevenagel: "Jones, The Knoevenagel Condensation, Org. React. 15:204-599 (1967), doi:10.1002/0471264180.or015.02.",
    knoevenagelHeavies: "Jones, The Knoevenagel Condensation, Org. React. 15:204-599 (1967), doi:10.1002/0471264180.or015.02: self-condensation and Michael-addition side reactions of the active-methylene component are the typical source of high-boiling heavies in this chemistry. No plant-specific figure exists for octocrylene; 3 wt% of the crude is the mid-point of the 2-5 wt% commonly seen for Knoevenagel condensations and is an engineering estimate, not a measured value."
  });

  root.ProcessUpscalingExamples = Object.freeze({
    citations,
    octocryleneExampleBasis,
    octocryleneExampleSteps,
    sampleText,
    biodieselExampleSteps,
    biodieselSampleText,
    biodieselReactionOnlyText
  });
})(globalThis);
