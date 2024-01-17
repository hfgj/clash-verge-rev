import dayjs from "dayjs";
import useSWR, { mutate } from "swr";
import { useState } from "react";
import {
  Button,
  IconButton,
  List,
  ListItem,
  ListItemText,
  styled,
  Box,
  alpha,
  Typography,
  Divider,
} from "@mui/material";
import { RefreshRounded } from "@mui/icons-material";
import { useTranslation } from "react-i18next";
import { useLockFn } from "ahooks";
import { getProxyProviders, proxyProviderUpdate } from "@/services/api";
import { BaseDialog } from "../base";

export const ProviderButton = () => {
  const { t } = useTranslation();
  const { data } = useSWR("getProxyProviders", getProxyProviders);

  const [open, setOpen] = useState(false);

  const hasProvider = Object.keys(data || {}).length > 0;

  const handleUpdate = useLockFn(async (key: string) => {
    await proxyProviderUpdate(key);
    await mutate("getProxies");
    await mutate("getProxyProviders");
  });

  if (!hasProvider) return null;

  return (
    <>
      <Button
        size="small"
        variant="outlined"
        sx={{ textTransform: "capitalize" }}
        onClick={() => setOpen(true)}
      >
        {t("Provider")}
      </Button>

      <BaseDialog
        open={open}
        title={
          <Box display="flex" justifyContent="space-between" gap={1}>
            <Typography variant="h6">{t("Proxy Provider")}</Typography>
            <Button
              variant="contained"
              onClick={async () => {
                Object.entries(data || {}).forEach(async ([key, item]) => {
                  await proxyProviderUpdate(key);
                  await mutate("getProxies");
                  await mutate("getProxyProviders");
                });
              }}
            >
              {t("Update All")}
            </Button>
          </Box>
        }
        contentSx={{ width: 400 }}
        disableOk
        cancelBtn={t("Cancel")}
        onClose={() => setOpen(false)}
        onCancel={() => setOpen(false)}
      >
        <List sx={{ py: 0, minHeight: 250 }}>
          {Object.entries(data || {}).map(([key, item]) => {
            const time = dayjs(item.updatedAt);
            return (
              <>
                <ListItem sx={{ p: 0 }} key={key}>
                  <ListItemText
                    primary={
                      <>
                        <Typography
                          variant="h6"
                          component="span"
                          noWrap
                          title={key}
                        >
                          {key}
                        </Typography>
                      </>
                    }
                    secondary={
                      <>
                        <StyledTypeBox component="span">
                          {item.vehicleType}
                        </StyledTypeBox>
                        <StyledTypeBox component="span">
                          {t("Update At")} {time.fromNow()}
                        </StyledTypeBox>
                      </>
                    }
                  />
                  <IconButton
                    size="small"
                    color="inherit"
                    title="Update Provider"
                    onClick={() => handleUpdate(key)}
                  >
                    <RefreshRounded />
                  </IconButton>
                </ListItem>
                <Divider />
              </>
            );
          })}
        </List>
      </BaseDialog>
    </>
  );
};

const StyledTypeBox = styled(Box)(({ theme }) => ({
  display: "inline-block",
  border: "1px solid #ccc",
  borderColor: alpha(theme.palette.primary.main, 0.5),
  color: alpha(theme.palette.primary.main, 0.8),
  borderRadius: 4,
  fontSize: 10,
  marginRight: "4px",
  padding: "0 2px",
  lineHeight: 1.25,
}));
