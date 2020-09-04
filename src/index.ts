/* eslint-disable no-await-in-loop */
// index.ts
import {
  setupDatabase,
  getAllFromProfile,
  getMyFileDownloadConflicts,
  getWalletBalance,
  sleep,
  checkUploadStatus,
  uploadArDriveFiles,
  getPriceOfNextUploadBatch,
  getMyArDriveFilesFromPermaWeb,
  downloadMyArDriveFiles,
  watchFolder,
  resolveFileDownloadConflict,
} from 'ardrive-core-js'
import {
  setupAndGetUser,
  userLogin,
  promptForArDriveUpload,
  promptForFileOverwrite,
} from './prompts';

async function main() {
  console.log('       ___   _____    _____   _____    _   _     _   _____  ');
  console.log(
    '      /   | |  _  \\  |  _  \\ |  _  \\  | | | |   / / | ____| '
  );
  console.log('     / /| | | |_| |  | | | | | |_| |  | | | |  / /  | |__   ');
  console.log('    / /_| | |  _  /  | | | | |  _  /  | | | | / /   |  __|  ');
  console.log(
    '   / /  | | | | \\ \\  | |_| | | | \\ \\  | | | |/ /    | |___  '
  );
  console.log(
    '  /_/   |_| |_|  \\_\\ |_____/ |_|  \\_\\ |_| |___/     |_____| '
  );
  console.log('');
  // Setup database if it doesnt exist
  try {
    await setupDatabase('./.ardrive-cli.db');
  } catch (err) {
    console.error(err);
    return;
  }

  // Check if user exists, if not, create a new one
  const profile = await getAllFromProfile();
  let user;
  let uploadBatch;
  let readyToUpload;
  let fileDownloadConflicts;

  if (profile === undefined || profile.length === 0) {
    user = await setupAndGetUser();
  } else {
    // Allow the user to login
    user = await userLogin(profile[0].walletPubicKey, profile[0].owner);
  }
  watchFolder(user.syncFolderPath, user.arDriveId);
  // Run this in a loop
  while (true && user !== 0) {
    await getMyArDriveFilesFromPermaWeb(user);
    // await queueNewFiles(user, user.syncFolderPath);
    await checkUploadStatus();
    uploadBatch = await getPriceOfNextUploadBatch();
    if (uploadBatch) {
      readyToUpload = await promptForArDriveUpload(
        uploadBatch.totalArDrivePrice,
        uploadBatch.totalSize,
        uploadBatch.totalNumberOfFileUploads,
        uploadBatch.totalNumberOfMetaDataUploads,
        uploadBatch.totalNumberOfFolderUploads
      );
      await uploadArDriveFiles(user, readyToUpload);
    }
    await downloadMyArDriveFiles(user);
    fileDownloadConflicts = await getMyFileDownloadConflicts();
    if (fileDownloadConflicts) {
      fileDownloadConflicts.forEach(async (fileDownloadConflict: any) => {
        const response = await promptForFileOverwrite(
          fileDownloadConflict.fullPath
        );
        await resolveFileDownloadConflict(
          response,
          fileDownloadConflict.fileName,
          fileDownloadConflict.filePath,
          fileDownloadConflict.id
        );
      });
    }
    const today = new Date();
    const date = `${today.getFullYear()}-${
      today.getMonth() + 1
    }-${today.getDate()}`;
    const time = `${today.getHours()}:${today.getMinutes()}:${today.getSeconds()}`;
    const dateTime = `${date} ${time}`;
    const balance = await getWalletBalance(user.walletPubicKey);
    console.log(
      '%s Syncronization completed.  Current AR Balance: %s',
      dateTime,
      balance
    );
    await sleep(30000);
  }
}
main();