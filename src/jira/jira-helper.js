/* eslint-disable no-console */
/* eslint-disable max-len */
const JiraApi = require('jira-client');
const needle = require('needle');
const fs = require('fs');
const util = require('util');
const exec = util.promisify(require('child_process').exec);

// Initialize jira connection for auth user
const jira = new JiraApi({
  protocol: 'https',
  apiVersion: process.env.JIRA_API_VERSION,
  username: process.env.JIRA_USERNAME,
  password: process.env.JIRA_BEARER_TOKEN,
  host: process.env.JIRA_HOST,
});
let xmlReportFiles;
let xrayToken;
let verifiedJiraTicketsList;
let jiraProjectKeysArray;
let branchToCompare;
let branchName;
const projectKey = 'DEMO';

/** Create test execution ticket with github action run details
   * @name createJiraTestExecutionTicket
   * @function
   * @param {String} githubRepo - Github repository name where the tests are executed
   * @param {Number} githubRun - Github actions run number
   * @param {String} env - Environment name where the tests are executed
   * @param {String} actor - Github actor who executed the tests
   * @param {Number} githubRunId - Github run id
   * @param {String} branchName - Branch name from which tests have been executed
   * @returns {String} Returns Jira key for created test execution ticket
   * @throws {Error} Will throw an error if it cannot connect to Jira, payload is incorrect, or ticket cannot be created, and will return null
   */
const createJiraTestExecutionTicket = async (githubRepo, githubRun, env, actor, githubRunId, branchName) => {
  try {
    const issueObject = {
      fields: {
        project: {
          key: projectKey,
        },
        summary: `Automated test run for ${githubRepo}, github run number: #${githubRun} | Env: ${env}`,
        description: `Automated test results executed for ${githubRepo} on branch ${branchName} by ${actor}.
        Click https://github.com/${githubRepo}/actions/runs/${githubRunId} to see the Github Action workflow summary.`,
        issuetype: {
          id: 10008,
        },
      },

    };
    const issue = await jira.addNewIssue(issueObject);
    const testExecutionKey = issue.key;
    return testExecutionKey;
  } catch (err) {
    console.error(err);
    return null;
  }
};

/** Create an array with all xml test results
   * @name listXmlReports
   * @function
   * @param {String} dir - Directory where xml test results are stored
   * @returns {Array} Will return array with xml test reports
   */
const listXmlReports = async (dir) => {
  xmlReportFiles = [];
  const files = fs.readdirSync(dir);
  const regex = new RegExp(/^.*.xml/);

  for (let i = 0; i < files.length; i += 1) {
    if (regex.test(files[i])) {
      xmlReportFiles.push(files[i]);
    }
  }
  return xmlReportFiles;
};

/** Authenticate and import xml data to XRAY
   * @name importXmlDataToXray
   * @function
   * @param {String} dir - Directory where xml test results are stored
   * @param {String} testExecutionKey - Jira test execution key where test results will be imported
   * @returns {String} Authenticate bearer token for xray and xray import response
   * @throws {Error} Will throw an error if bearer token cannot be created, error response, or file cannot be imported correctly
   */
const importXmlDataToXray = async (dir, testExecutionKey) => {
  await listXmlReports(dir);
  await needle(
    'POST',
    `${process.env.XRAY_CLOUD_URL}/api/v2/authenticate`,
    {
      client_id: process.env.XRAY_CLIENT_ID,
      client_secret: process.env.XRAY_CLIENT_SECRET,
    },
    {
      headers: {
        'content-type': 'application/json',
      },
    },
  ).then((res) => {
    console.log(`Generated Xray token => ${res.body}`);
    xrayToken = res.body;
  }).catch((error) => {
    console.log(error);
  });

  xmlReportFiles.forEach(async (xmlFile) => {
    const xmlBodyString = fs.createReadStream(`${dir}/${xmlFile}`);
    await needle(
      'POST',
      `${process.env.XRAY_CLOUD_URL}/api/v2/import/execution/junit?projectKey=${projectKey}&testExecKey=${testExecutionKey}`,
      xmlBodyString,
      {
        headers: {
          Authorization: `Bearer ${xrayToken}`,
          'content-type': 'text/xml',
        },
      },
    ).then((res) => {
      console.log(`XRAY RESPONSE => ${JSON.stringify(res.body)}`);
    }).catch((error) => {
      console.log(error);
    });
    console.log(xmlFile);
  });
};

/** Update test execution ticket status to Done
   * @name updateTestExecutionTicketStatus
   * @function
   * @returns {String} Information that ticket status has been updated
   * @throws {Error} Will throw an error if ticket cannot be updated and will return null
   */
const updateTestExecutionTicketStatus = async (testExecutionKey) => {
  // Transition id for value 31 is equal Done in JIRA
  try {
    const issueTransitionBody = {
      transition: { id: '31' },
    };
    await jira.transitionIssue(testExecutionKey, issueTransitionBody);
    console.log(`Successfully set status to Done for ${testExecutionKey}`);
  } catch (err) {
    console.error(err);
  }
};

/** Get related ticket number from git log history
   * @name findRelatedJiraTicket
   * @function
   * @param {String} currentBranchToCompare - Branch to comapre with
   * @param {String} currentBranchName - Current working branch, which will be compared to the base branch
   * @param {Boolean} executedFromCI - Define if function is executed locally or from CI
   * @returns {Array} Returns jira tickets array with unique items
   * @throws {Error} Will throw an error if correct jira ticket is not returned
   */
const findRelatedJiraTicket = async (currentBranchToCompare, currentBranchName, executedFromCI = false) => {
  verifiedJiraTicketsList = [];
  if (executedFromCI === true) {
    branchToCompare = `origin/${currentBranchToCompare}`;
    branchName = `origin/${currentBranchName}`;
  } else {
    branchToCompare = currentBranchToCompare;
    branchName = currentBranchName;
  }
  const { stdout: jiraTickets } = await exec(`git log --pretty=oneline --no-merges ${branchToCompare}..${branchName} | grep -e '[a-zA-Z]\\+-[0-9]\\+' -o | sort -u`);
  const tickets = jiraTickets.split('\n').filter(String).map((key) => key.toUpperCase());
  const initialJiraTicketsList = [...new Set(tickets)];

  // Return all project keys from Jira, so we can make sure keys returned from git log are mapped correctly
  jiraProjectKeysArray = [];
  const jiraProjects = await jira.listProjects();
  jiraProjects.forEach(async (item) => {
    jiraProjectKeysArray.push(item.key);
  });

  // Additional check if Jira tickets are correctly mapped - check by regex and comapring to array of returned keys from Jira
  for (let i = 0; i < initialJiraTicketsList.length; i += 1) {
    const extractedKey = () => initialJiraTicketsList[i].replace(/[^a-zA-Z]/g, '');
    if (initialJiraTicketsList[i].match(/([a-zA-Z][a-zA-Z0-9]+-[0-9]+)/g) && jiraProjectKeysArray.includes(extractedKey())) {
      verifiedJiraTicketsList.push(initialJiraTicketsList[i]);
    } else {
      throw new Error('Could not find related Jira ticket');
    }
  }
  return verifiedJiraTicketsList;
};

/** Link test execution results to the related ticket
   * @name linkTestExecutionResults
   * @function
   * @param {String} currentBranchName - Github repository name where the tests are executed
   * @param {String} jiraExecutionTicket - Environment name where the tests are executed
   * @returns {String} Returns information about linked tikcets
   * @throws {Error} Will throw an error if jira ticket cannot be updated with linked issue
   */
const linkTestExecutionResults = async (relatedJiraTickets, jiraExecutionTicket) => {
  const issueObject = {
    update: {
      issuelinks: [
        {
          add: {
            type: {
              name: 'Test',
              inward: 'is tested by',
              outward: 'tests',
            },
            inwardIssue: {
              key: jiraExecutionTicket,
            },
          },
        },
      ],
    },
  };
  if (!relatedJiraTickets.length > 0) {
    console.log(`There are no related tickets where the test execution can be linked, to see test results just go
    directly here: ${jiraExecutionTicket}`);
  }
  try {
    relatedJiraTickets.forEach(async (ticket) => {
      await jira.updateIssue(ticket, issueObject, {});
      console.log(`Ticket: ${ticket} has been successfully linked with tests results coming from ${jiraExecutionTicket}`);
    });
  } catch (err) {
    console.log(err);
  }
};

const addInfoAboutExecution = async (relatedJiraTickets, path, githubRepo, currentBranchName, env, actor, githubRunId, reportLink) => {
  console.log(relatedJiraTickets);
  const reportStream = fs.createReadStream(path);
  if (!relatedJiraTickets.length > 0) {
    console.log('There are no related tickets where test report can be linked');
  } else {
    relatedJiraTickets.forEach(async (ticket) => {
      try {
        const attachements = await jira.addAttachmentOnIssue(ticket, reportStream);
        attachements.forEach(async (attachement) => {
          console.log(`File ${attachement.filename} linked correctly to the ticket: ${ticket}`);
        });
      } catch (err) {
        console.log(err);
      }
    });

    const comment = {
      body: `Automated test run has been executed for ${githubRepo} on branch ${currentBranchName} and ${env} environment by ${actor}.
    Click https://github.com/${githubRepo}/actions/runs/${githubRunId} to see the Github Action workflow summary,
    or here to see full report ${reportLink}`,
    };
    relatedJiraTickets.forEach(async (ticket) => {
      try {
        const res = await jira.addCommentAdvanced(ticket, comment);
        console.log(`Comment add to ${ticket} by ${res.author.displayName}`);
      } catch (err) {
        console.log(err);
      }
    });
  }
};

module.exports = {
  createJiraTestExecutionTicket,
  listXmlReports,
  importXmlDataToXray,
  updateTestExecutionTicketStatus,
  findRelatedJiraTicket,
  linkTestExecutionResults,
  addInfoAboutExecution,
};
