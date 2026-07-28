
import 'docusign-esign';


// exports.docOptions = require('./documentOptions.json');
// exports.docNames = require('./documentNames.json');
// const settings = require('./appsettings.json');
// exports.github = require('./github.json');
const settings = require ( '../docusign-config/appsettings.json')
const dsOauthServer = settings.production
  ? 'https://account.docusign.com'
  : 'https://account-d.docusign.com';

settings.gatewayAccountId = process.env.DS_PAYMENT_GATEWAY_ID || settings.gatewayAccountId;
settings.dsClientSecret = process.env.DS_CLIENT_SECRET || settings.dsClientSecret;
settings.signerEmail = process.env.DS_SIGNER_EMAIL || settings.signerEmail;
settings.signerName = process.env.DS_SIGNER_NAME || settings.signerName;
settings.dsClientId = process.env.DS_CLIENT_ID || settings.dsClientId;
settings.appUrl = process.env.DS_APP_URL || settings.appUrl;
settings.dsJWTClientId = process.env.DS_JWT_CLIENT_ID || settings.dsJWTClientId;
settings.privateKeyLocation = process.env.DS_PRIVATE_KEY_PATH  || settings.privateKeyLocation;
settings.impersonatedUserGuid =  process.env.DS_IMPERSONATED_USER_GUID || settings.impersonatedUserGuid;

exports.config = {
  dsOauthServer,
};
const path = require('path')
    , fs = require('fs-extra')
    , docusign = require('docusign-esign')
    , validator = require('validator')
    , dsConfig = require('../../config/index.js').config
    ;

const eg002SigningViaEmail = exports
    , eg = 'eg002' // This example reference.
    , mustAuthenticate = '/ds/mustAuthenticate'
    , minimumBufferMin = 3
    , demoDocsPath = path.resolve(__dirname, '../../demo_documents')
    , doc2File = 'World_Wide_Corp_Battle_Plan_Trafalgar.docx'
    , doc3File = 'World_Wide_Corp_lorem.pdf'
    ;


/**
 * Create the envelope
 * @param {object} req Request obj
 * @param {object} res Response obj
 */
eg002SigningViaEmail.createController = async (req: { dsAuth: { checkToken: (arg0: number) => any; setEg: (arg0: any, arg1: string) => void; }; flash: (arg0: string, arg1: string) => void; body: any; user: { accessToken: any; }; session: { basePath: any; accountId: any; envelopeId: any; }; }, res: { redirect: (arg0: string) => void; render: (arg0: string, arg1: { err?: any; errorCode?: any; errorMessage?: any; title?: string; h1?: string; message?: string; }) => void; }) => {
    // Step 1. Check the token
    // At this point we should have a good token. But we
    // double-check here to enable a better UX to the user.
    const tokenOK = req.dsAuth.checkToken(minimumBufferMin);
    if (! tokenOK) {
        req.flash('info', 'Sorry, you need to re-authenticate.');
        // Save the current operation so it will be resumed after authentication
        req.dsAuth.setEg(req, eg);
        res.redirect(mustAuthenticate);
    }

    // Step 2. Call the worker method
    let body = req.body
      , signerEmail = validator.escape(body.signerEmail)
      , signerName = validator.escape(body.signerName)
      , ccEmail = validator.escape(body.ccEmail)
      , ccName = validator.escape(body.ccName)
      , envelopeArgs = {
            signerEmail,
            signerName,
            ccEmail,
            ccName,
            status: "sent" }
      , args = {
            accessToken: req.user.accessToken,
            basePath: req.session.basePath,
            accountId: req.session.accountId,
            envelopeArgs
        }
      , results = null
      ;

    try {
        results = await eg002SigningViaEmail.worker (args)
    }
    catch (error) {
        const errorBody = error && error.response && error.response.body
            // we can pull the DocuSign error code and message from the response body
          , errorCode = errorBody && errorBody.errorCode
          , errorMessage = errorBody && errorBody.message
          ;
        // In production, may want to provide customized error messages and
        // remediation advice to the user.
        res.render('pages/error', {err: error, errorCode, errorMessage});
    }
    if (results) {
        req.session.envelopeId = results.envelopeId; // Save for use by other examples
            // which need an envelopeId
        res.render('pages/example_done', {
            title: "Envelope sent",
            h1: "Envelope sent",
            message: `The envelope has been created and sent!<br/>Envelope ID ${results.envelopeId}.`
        });
    }
}

/**
 * This function does the work of creating the envelope
 */
// ***DS.snippet.0.start
eg002SigningViaEmail.worker = async (args: { basePath: any; accessToken: string; envelopeArgs: any; accountId: any; }) => {
    // Data for this method
    // args.basePath
    // args.accessToken
    // args.accountId

    const dsApiClient = new docusign.ApiClient();
    dsApiClient.setBasePath(args.basePath);
    dsApiClient.addDefaultHeader('Authorization', 'Bearer ' + args.accessToken);
    let envelopesApi = new docusign.EnvelopesApi(dsApiClient)
      , results = null;

    // Step 1. Make the envelope request body
    const envelope = makeEnvelope(args.envelopeArgs)

    // Step 2. call Envelopes::create API method
    // Exceptions will be caught by the calling function
    results = await envelopesApi.createEnvelope(args.accountId,
        {envelopeDefinition: envelope});
    const envelopeId = results.envelopeId;

    console.log(`Envelope was created. EnvelopeId ${envelopeId}`);
    return ({envelopeId})
}

/**
 * Creates envelope
 * @function
 * @param {Object} args parameters for the envelope
 * @returns {Envelope} An envelope definition
 * @private
 */
function makeEnvelope(args: { signerEmail: any; signerName: any; ccEmail: any; ccName: any; status: any; }){
    // Data for this method
    // args.signerEmail
    // args.signerName
    // args.ccEmail
    // args.ccName
    // args.status
    // demoDocsPath (module constant)
    // doc2File (module constant)
    // doc3File (module constant)


    // document 1 (html) has tag **signature_1**
    // document 2 (docx) has tag /sn1/
    // document 3 (pdf) has tag /sn1/
    //
    // The envelope has two recipients.
    // recipient 1 - signer
    // recipient 2 - cc
    // The envelope will be sent first to the signer.
    // After it is signed, a copy is sent to the cc person.

    let doc2DocxBytes, doc3PdfBytes;
    // read files from a local directory
    // The reads could raise an exception if the file is not available!
    doc2DocxBytes = fs.readFileSync(path.resolve(demoDocsPath, doc2File));
    doc3PdfBytes = fs.readFileSync(path.resolve(demoDocsPath, doc3File));

    // create the envelope definition
    const env = new docusign.EnvelopeDefinition();
    env.emailSubject = 'Please sign this document set';

    // add the documents
    const doc1 = new docusign.Document()
      , doc1b64 = Buffer.from(document1(args)).toString('base64')
      , doc2b64 = Buffer.from(doc2DocxBytes).toString('base64')
      , doc3b64 = Buffer.from(doc3PdfBytes).toString('base64')
      ;

    doc1.documentBase64 = doc1b64;
    doc1.name = 'Order acknowledgement'; // can be different from actual file name
    doc1.fileExtension = 'html'; // Source data format. Signed docs are always pdf.
    doc1.documentId = '1'; // a label used to reference the doc

    // Alternate pattern: using constructors for docs 2 and 3...
    const doc2 = new docusign.Document.constructFromObject({
            documentBase64: doc2b64,
            name: 'Battle Plan', // can be different from actual file name
            fileExtension: 'docx',
            documentId: '2'});

    const doc3 = new docusign.Document.constructFromObject({
            documentBase64: doc3b64,
            name: 'Lorem Ipsum', // can be different from actual file name
            fileExtension: 'pdf',
            documentId: '3'});

    // The order in the docs array determines the order in the envelope
    env.documents = [doc1, doc2, doc3];

    // create a signer recipient to sign the document, identified by name and email
    // We're setting the parameters via the object constructor
    const signer1 = docusign.Signer.constructFromObject({
        email: args.signerEmail,
        name: args.signerName,
        recipientId: '1',
        routingOrder: '1'});
    // routingOrder (lower means earlier) determines the order of deliveries
    // to the recipients. Parallel routing order is supported by using the
    // same integer as the order for two or more recipients.

    // create a cc recipient to receive a copy of the documents, identified by name and email
    // We're setting the parameters via setters
    const cc1 = new docusign.CarbonCopy();
    cc1.email = args.ccEmail;
    cc1.name = args.ccName;
    cc1.routingOrder = '2';
    cc1.recipientId = '2';

    // Create signHere fields (also known as tabs) on the documents,
    // We're using anchor (autoPlace) positioning
    //
    // The DocuSign platform searches throughout your envelope's
    // documents for matching anchor strings. So the
    // signHere2 tab will be used in both document 2 and 3 since they
    // use the same anchor string for their "signer 1" tabs.
    const signHere1 = docusign.SignHere.constructFromObject({
        anchorString: '**signature_1**',
        anchorYOffset: '10', anchorUnits: 'pixels',
        anchorXOffset: '20'})
    , signHere2 = docusign.SignHere.constructFromObject({
        anchorString: '/sn1/',
        anchorYOffset: '10', anchorUnits: 'pixels',
        anchorXOffset: '20'})
    ;

    // Tabs are set per recipient / signer
    const signer1Tabs = docusign.Tabs.constructFromObject({
    signHereTabs: [signHere1, signHere2]});
    signer1.tabs = signer1Tabs;

    // Add the recipients to the envelope object
    const recipients = docusign.Recipients.constructFromObject({
    signers: [signer1],
    carbonCopies: [cc1]});
    env.recipients = recipients;

    // Request that the envelope be sent by setting |status| to "sent".
    // To request that the envelope be created as a draft, set to "created"
    env.status = args.status;

    return env;
}

/**
 * Creates document 1
 * @function
 * @private
 * @param {Object} args parameters for the envelope
 * @returns {string} A document in HTML format
 */

function document1(args: { signerEmail: any; signerName: any; ccEmail: any; ccName: any; status?: any; }) {
    // Data for this method
    // args.signerEmail
    // args.signerName
    // args.ccEmail
    // args.ccName

    return `
    <!DOCTYPE html>
    <html>
        <head>
          <meta charset="UTF-8">
        </head>
        <body style="font-family:sans-serif;margin-left:2em;">
        <h1 style="font-family: 'Trebuchet MS', Helvetica, sans-serif;
            color: darkblue;margin-bottom: 0;">World Wide Corp</h1>
        <h2 style="font-family: 'Trebuchet MS', Helvetica, sans-serif;
          margin-top: 0px;margin-bottom: 3.5em;font-size: 1em;
          color: darkblue;">Order Processing Division</h2>
        <h4>Ordered by ${args.signerName}</h4>
        <p style="margin-top:0em; margin-bottom:0em;">Email: ${args.signerEmail}</p>
        <p style="margin-top:0em; margin-bottom:0em;">Copy to: ${args.ccName}, ${args.ccEmail}</p>
        <p style="margin-top:3em;">
  Candy bonbon pastry jujubes lollipop wafer biscuit biscuit. Topping brownie sesame snaps sweet roll pie. Croissant danish biscuit soufflé caramels jujubes jelly. Dragée danish caramels lemon drops dragée. Gummi bears cupcake biscuit tiramisu sugar plum pastry. Dragée gummies applicake pudding liquorice. Donut jujubes oat cake jelly-o. Dessert bear claw chocolate cake gummies lollipop sugar plum ice cream gummies cheesecake.
        </p>
        <!-- Note the anchor tag for the signature field is in white. -->
        <h3 style="margin-top:3em;">Agreed: <span style="color:white;">**signature_1**/</span></h3>
        </body>
    </html>
  `
  }
// ***DS.snippet.0.end

/**
 * Form page for this application
 */
eg002SigningViaEmail.getController = (req: { dsAuth: { checkToken: () => any; setEg: (arg0: any, arg1: string) => void; }; csrfToken: () => any; }, res: { render: (arg0: string, arg1: { eg: string; csrfToken: any; title: string; sourceFile: any; sourceUrl: any; documentation: string; showDoc: any; }) => void; redirect: (arg0: string) => void; }) => {
    // Check that the authentication token is ok with a long buffer time.
    // If needed, now is the best time to ask the user to authenticate
    // since they have not yet entered any information into the form.
    const tokenOK = req.dsAuth.checkToken();
    if (tokenOK) {
        res.render('pages/examples/eg002SigningViaEmail', {
            eg, csrfToken: req.csrfToken(),
            title: "Signing request by email",
            sourceFile: path.basename(__filename),
            sourceUrl: dsConfig.githubExampleUrl + path.basename(__filename),
            documentation: dsConfig.documentation + eg,
            showDoc: dsConfig.documentation
        });
    } else {
        // Save the current operation so it will be resumed after authentication
        req.dsAuth.setEg(req, eg);
        res.redirect(mustAuthenticate);
    }
}





